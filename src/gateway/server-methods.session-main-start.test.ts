import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import * as sessions from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { gatewayRequest } from "./request-frame.test-support.js";
import { makeClient } from "./server-broadcast.test-helpers.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";
import { handleGatewayRequest } from "./server-methods.js";
import { createHistoryReadContext } from "./server-methods/chat-history.test-helpers.js";
import { sessionsDiffHandlers } from "./server-methods/sessions-diff.js";
import { sessionsFilesHandlers } from "./server-methods/sessions-files.js";
import { sessionSubscriptionHandlers } from "./server-methods/sessions-subscriptions.js";
import type { GatewayRequestHandlers } from "./server-methods/types.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

// A session writer may open an agent's main conversation before anyone has used it.
afterEach(() => vi.restoreAllMocks());

const MAIN = "agent:main:main";
const WRITE = ["operator.sessions.write"];
const hidden = { ok: false, subscribed: false };
const admitted = { ok: true, subscribed: true };

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
    options: { scopes?: string[]; extraHandlers?: GatewayRequestHandlers } = {},
  ) => {
    const connId = `${method}-${++seq}`;
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
  const subscribe = async (key: string, opt: { scopes?: string[]; canonicalKey?: string } = {}) => {
    const result = await call("sessions.messages.subscribe", { key }, opt);
    return {
      ok: result.ok,
      subscribed: subscribers.get(opt.canonicalKey ?? key).has(result.connId),
    };
  };
  // Another creator's draft main conversation.
  const seedForeignDraft = () =>
    sessions.upsertSessionEntryCore(
      { agentId: "main", sessionKey: MAIN },
      {
        sessionId: "foreign-main",
        updatedAt: 1,
        visibility: "draft",
        createdActor: { type: "human", source: "profile", id: "main-owner" },
      },
    );
  return { call, subscribe, seedForeignDraft };
}

describe("starting an agent's main conversation", () => {
  it.each([false, true])(
    "admits a session writer only to its own absent main conversation (roles=%s)",
    async (roles) => {
      const cfg = roles ? rolePolicyConfig() : {};
      await withMainWriter(cfg, async ({ subscribe, seedForeignDraft }) => {
        // The first turn would create main for this writer, so its absence is not a secret.
        expect(await subscribe(MAIN)).toEqual(admitted);
        // Other absent keys, and readers that cannot start a conversation, stay hidden.
        expect(await subscribe("agent:main:other")).toEqual(hidden);
        expect(await subscribe(MAIN, { scopes: ["operator.sessions.read"] })).toEqual(hidden);
        // Another creator's draft main stays hidden from the same writer.
        await seedForeignDraft();
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

  const work = { session: { mainKey: "work" } };
  it.each([
    { name: "unprefixed", cfg: {}, key: "main", canonicalKey: MAIN },
    { name: "uppercase", cfg: {}, key: "AGENT:MAIN:MAIN", canonicalKey: MAIN },
    { name: "mainKey", cfg: work, key: "agent:main:work" },
    { name: "unprefixed mainKey", cfg: work, key: "work" },
    { name: "non-main", cfg: work, key: "agent:main:other", canonicalKey: "agent:main:other" },
  ])("canonicalizes the $name key under the main alias rules", async (alias) => {
    const expected = alias.name === "non-main" ? hidden : admitted;
    const canonicalKey = alias.canonicalKey ?? "agent:main:work";
    await withMainWriter(alias.cfg, async ({ subscribe }) => {
      expect(await subscribe(alias.key, { canonicalKey })).toEqual(expected);
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
});
