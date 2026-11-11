import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import * as sessions from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { gatewayRequest } from "./request-frame.test-support.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { makeClient } from "./server-broadcast.test-helpers.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";
import { handleGatewayRequest } from "./server-methods.js";
import { createHistoryReadContext } from "./server-methods/chat-history.test-helpers.js";
import { sessionsDiffHandlers } from "./server-methods/sessions-diff.js";
import { sessionsFilesHandlers } from "./server-methods/sessions-files.js";
import { sessionSubscriptionHandlers } from "./server-methods/sessions-subscriptions.js";
import type { GatewayRequestHandlers } from "./server-methods/types.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import {
  createProjectedSessionEventPredicate,
  roleClient,
  rolePolicyConfig,
} from "./session-sharing.test-utils.js";

// A session writer may open an agent's main conversation before anyone has used it.
afterEach(() => vi.restoreAllMocks());

const MAIN = "agent:main:main";
const WRITE = ["operator.sessions.write"];
const hidden = { ok: false, subscribed: false };
const admitted = { ok: true, subscribed: true };
const actor = (id: string) => ({ type: "human" as const, source: "profile" as const, id });

function withMainWriter(
  cfg: OpenClawConfig,
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
  role: Parameters<typeof roleClient>[0] = "view",
) {
  return withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: true },
    async (state) => {
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      await state.writeConfig(cfg);
      await run(await createFixture(cfg, role));
    },
  );
}

async function createFixture(cfg: OpenClawConfig, role: Parameters<typeof roleClient>[0]) {
  const peer = makeClient("main-writer", "operator", []);
  Object.assign(peer.client, roleClient(role, "main-writer"));
  const writer = peer.client;
  writer.connect.scopes = WRITE;
  writer.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
  prepareGatewayRecipientProfile(writer);
  setRuntimeConfigSnapshot(cfg);
  const subscribers = createSessionMessageSubscriberRegistry();
  const context = await createHistoryReadContext({
    getRuntimeConfig: () => cfg,
    subscribeSessionMessageEvents: subscribers.subscribe,
  });
  let seq = 0;
  const call = async (
    method: string,
    params: Record<string, unknown>,
    options: { scopes?: string[]; connId?: string; extraHandlers?: GatewayRequestHandlers } = {},
  ) => {
    const connId = options.connId ?? `${method}-${++seq}`;
    const client = {
      ...writer,
      connId,
      connect: { ...writer.connect, scopes: options.scopes ?? WRITE },
    };
    const respond = vi.fn();
    await handleGatewayRequest({
      req: gatewayRequest(connId, method, params),
      client,
      context,
      respond,
      isWebchatConnect: () => false,
      extraHandlers: { ...sessionSubscriptionHandlers, ...options.extraHandlers },
    });
    const [ok, payload, error] = respond.mock.calls[0] ?? [];
    return { ok, payload, error, connId };
  };
  const subscribe = async (
    key: string,
    options: { scopes?: string[]; connId?: string; canonicalKey?: string } = {},
  ) => {
    const result = await call("sessions.messages.subscribe", { key }, options);
    return {
      ok: result.ok,
      subscribed: subscribers.get(options.canonicalKey ?? key).has(result.connId),
    };
  };
  const seed = (sessionKey: string, entry: { owner: string; visibility: "shared" | "draft" }) =>
    sessions.upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: `${entry.owner}-${sessionKey}`,
        updatedAt: 1,
        visibility: entry.visibility,
        createdActor: actor(entry.owner),
      },
    );
  const writerId = writer.authenticatedUserProfile!.profileId;
  return { cfg, context, peer, writer, writerId, subscribers, call, subscribe, seed };
}

describe("starting an agent's main conversation", () => {
  it.each([false, true])(
    "admits a session writer only to its own absent main conversation (roles=%s)",
    async (roles) => {
      await withMainWriter(roles ? rolePolicyConfig() : {}, async ({ subscribe, seed }) => {
        // The first turn would create main for this writer, so its absence is not a secret.
        expect(await subscribe(MAIN)).toEqual(admitted);
        // Other absent keys, and readers that cannot start a conversation, stay hidden.
        expect(await subscribe("agent:main:other")).toEqual(hidden);
        expect(await subscribe(MAIN, { scopes: ["operator.sessions.read"] })).toEqual(hidden);
        // Another creator's draft main stays hidden from the same writer.
        await seed(MAIN, { owner: "main-owner", visibility: "draft" });
        expect(await subscribe(MAIN)).toEqual(hidden);
      });
    },
  );

  it.each([
    { agents: ["main"], expected: admitted },
    { agents: ["other"], expected: hidden },
  ])("follows the role's agent limit ($agents)", async ({ agents, expected }) => {
    await withMainWriter(
      rolePolicyConfig(agents),
      async ({ subscribe }) => {
        // A first turn on an excluded agent is refused, so its main stays indistinguishable.
        expect(await subscribe(MAIN)).toEqual(expected);
      },
      "write",
    );
  });

  it.each([
    { name: "unprefixed", cfg: {}, key: "main", canonicalKey: MAIN },
    { name: "uppercase", cfg: {}, key: "AGENT:MAIN:MAIN", canonicalKey: MAIN },
    { name: "mainKey", cfg: { session: { mainKey: "work" } }, key: "agent:main:work" },
    { name: "unprefixed mainKey", cfg: { session: { mainKey: "work" } }, key: "work" },
  ])("canonicalizes the $name main key alias", async ({ cfg, key, canonicalKey }) => {
    const resolved = canonicalKey ?? "agent:main:work";
    await withMainWriter(cfg, async ({ subscribe }) => {
      expect(await subscribe(key, { canonicalKey: resolved })).toEqual(admitted);
    });
  });

  it("keeps a non-main key hidden under a mainKey override", async () => {
    await withMainWriter({ session: { mainKey: "work" } }, async ({ subscribe }) => {
      expect(await subscribe("agent:main:other")).toEqual(hidden);
    });
  });

  it.each(["sessions.files.list", "sessions.diff"])(
    "keeps %s on an absent main hidden",
    async (method) => {
      await withMainWriter(rolePolicyConfig(), async ({ call, subscribe }) => {
        expect(await subscribe(MAIN)).toEqual(admitted);
        const extraHandlers = { ...sessionsFilesHandlers, ...sessionsDiffHandlers };
        expect(await call(method, { sessionKey: MAIN }, { extraHandlers })).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining("was not found") },
        });
      });
    },
  );

  it("delivers nothing from another creator's draft main to an early subscriber", async () => {
    await withMainWriter(rolePolicyConfig(), async (fixture) => {
      const { cfg, context, peer, writer, writerId, subscribers, subscribe, seed } = fixture;
      const own = "agent:main:own";
      await seed(own, { owner: writerId, visibility: "draft" });
      expect(await subscribe(own, { connId: writer.connId })).toEqual(admitted);
      expect(await subscribe(MAIN, { connId: writer.connId })).toEqual(admitted);
      await seed(MAIN, { owner: "main-owner", visibility: "draft" });
      const projection = getSessionRowProjection(context)!;
      await projection.ensureMaterialized();
      const { broadcastToConnIds } = createGatewayBroadcaster({
        clients: new GatewayClientRegistry([writer]),
        sessionMessageSubscribers: subscribers,
        canReceiveSessionEvent: createProjectedSessionEventPredicate(cfg, projection),
      });
      const emit = (sessionKey: string) => {
        const scope = { agentId: "main", sessionKeys: [sessionKey] };
        const connIds = new Set(subscribers.get(sessionKey));
        broadcastToConnIds("chat", { sessionKey, runId: "run", state: "final" }, connIds, scope);
        const message = { role: "assistant", content: "private" };
        broadcastToConnIds("session.message", { sessionKey, message }, connIds, scope);
      };
      emit(MAIN);
      expect(peer.socket.events).toEqual([]);
      // The same client receives both events for a conversation it may read.
      emit(own);
      expect(peer.socket.events).toEqual(["chat", "session.message"]);
    });
  });

  it.each(["shared", "draft"] as const)(
    "refuses a session writer's turn on another creator's %s main",
    async (visibility) => {
      await withMainWriter(rolePolicyConfig(), async ({ call, seed, writerId }) => {
        const send = vi.fn(({ respond }) => respond(true, { status: "started" }));
        const turn = (sessionKey: string) =>
          call(
            "chat.send",
            { sessionKey, message: "hello", idempotencyKey: `turn-${sessionKey}` },
            { extraHandlers: { "chat.send": send } },
          );
        await seed(MAIN, { owner: "main-owner", visibility });
        expect(await turn(MAIN)).toMatchObject({ ok: false });
        expect(send).not.toHaveBeenCalled();
        // The router admits the same caller's turn on its own conversation.
        await seed("agent:main:own", { owner: writerId, visibility });
        expect(await turn("agent:main:own")).toMatchObject({ ok: true });
        expect(send).toHaveBeenCalledOnce();
      });
    },
  );
});
