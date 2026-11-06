import { randomUUID } from "node:crypto";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, expect, test } from "vitest";
import type { WebSocket } from "ws";
import type { ResponseFrame } from "../../packages/gateway-protocol/src/schema/frames.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import {
  appendTranscriptMessage,
  listSessionPendingInputs,
  loadSessionEntry,
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { listActiveSessionRunIds } from "../sessions/session-controller.queries.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  BROWSER_ORIGIN,
  browserProxyAuth,
  configureBrowserAuth,
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  testState,
} from "./server.auth.test-helpers.js";
import {
  agentCommandMock,
  createGatewaySuiteHarness,
  dispatchInboundMessageMock,
  gatewayReplyMock,
  prepareGatewayReplyRuntimeForTest,
} from "./test-helpers.js";

const emails = {
  creator: "acl-creator@example.test",
  selected: "acl-selected@example.test",
  outsider: "acl-outsider@example.test",
  admin: "acl-admin@example.test",
};
type Actor = keyof typeof emails;
const profileIds = new Map<Actor, string>();
const people = new Map<Actor, WebSocket>();
let harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
const privateKey = "agent:main:dashboard:acl-private-fixture";
const text = "confidential websocket fixture";

function recordApprovedInput(sessionKey: string) {
  const completed = createDeferred();
  dispatchInboundMessageMock.mockImplementationOnce(async (params: unknown) => {
    const { ctx, replyOptions } = params as Parameters<typeof dispatchInboundMessage>[0];
    try {
      expect(ctx.SessionKey).toBe(sessionKey);
      expect(replyOptions?.userTurnTranscriptRecorder).toBeDefined();
      await replyOptions?.userTurnTranscriptRecorder?.persistApproved();
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    } finally {
      completed.resolve();
    }
  });
  return completed;
}

const describeSession = (socket: WebSocket, key: string) =>
  rpcReq<{ session: { key: string; accessMode?: string } | null }>(socket, "sessions.describe", {
    key,
  });

function expectOpaqueMissing(response: Awaited<ReturnType<typeof rpcReq>>, key: string) {
  expect(response, JSON.stringify(response.error)).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: 'Session "' + key + '" was not found.' },
  });
}

function seedEntry(
  scope: Parameters<typeof upsertSessionEntryCore>[0],
  sessionId: string,
  access?: SessionEntry["access"],
) {
  return upsertSessionEntryCore(scope, {
    sessionId,
    updatedAt: Date.now(),
    visibility: "shared",
    ...(access ? { access } : {}),
    createdActor: { type: "human", source: "profile", id: profileIds.get("creator")! },
  });
}

async function restartFixtureGateway() {
  for (const socket of people.values()) {
    socket.terminate();
  }
  people.clear();
  await harness.close();
  harness = await createGatewaySuiteHarness();
}

async function configureAccess() {
  await configureBrowserAuth(browserProxyAuth(), {
    roles: {
      default: "staff",
      definitions: {
        staff: {
          agents: ["main"],
          scopes: ["operator.read", "operator.write", "operator.talk"],
          sessions: { others: "write" },
        },
        admin: { agents: "*", scopes: ["operator.admin"], sessions: { others: "write" } },
      },
    },
  });
  testState.sessionConfig = {
    sharing: {
      accessPolicy: {
        default: "creator",
        groups: [
          {
            agentId: "main",
            channel: "telegram",
            peerId: "-100123",
            profileIds: [profileIds.get("selected")!],
          },
        ],
      },
    },
  };
}

installGatewayTestHooks({
  scope: "suite",
  setup: async () => {
    for (const actor of Object.keys(emails) as Actor[]) {
      profileIds.set(actor, ensureProfileForEmail(emails[actor]).id);
    }
    setUserProfileRole(profileIds.get("admin")!, "admin");
    await configureAccess();
    // Match the session-create harness: lazy loading is not RPC execution.
    await import("./server-methods/sessions-create.js");
    harness = await createGatewaySuiteHarness();
  },
  cleanup: async () => {
    // The suite owner joins late setup before cleanup, even if beforeAll times out.
    for (const socket of people.values()) {
      socket.terminate();
    }
    people.clear();
    await harness?.close();
  },
});

async function openIdentity(email?: string) {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("Gateway fixture must own an isolated state directory");
  }
  const socket = await harness.openWs({
    origin: BROWSER_ORIGIN,
    "x-forwarded-for": "203.0.113.50",
    "x-forwarded-proto": "https",
    "x-forwarded-user": email ?? "",
  });
  try {
    const response = await connectReq(socket, {
      client: CONTROL_UI_CLIENT,
      browserOrigin: BROWSER_ORIGIN,
      skipDefaultAuth: true,
      prePairDevice: true,
      deviceIdentityPath: path.join(
        stateDir,
        "acl-identities",
        email ?? "unknown",
        "client",
        "credentials.sqlite",
      ),
      scopes:
        email === emails.admin
          ? ["operator.admin"]
          : ["operator.read", "operator.write", "operator.talk"],
    });
    return { socket, response };
  } catch (error) {
    socket.terminate();
    throw error;
  }
}

async function client(actor: Actor) {
  const existing = people.get(actor);
  if (existing) {
    return existing;
  }
  const { socket, response } = await openIdentity(emails[actor]);
  if (!response.ok) {
    socket.terminate();
    throw new Error("Fixture authentication failed: " + JSON.stringify(response.error));
  }
  people.set(actor, socket);
  return socket;
}

beforeEach(async () => {
  // The suite reset preserves the physical store, not mutable config fixtures.
  await configureAccess();
  await seedEntry({ agentId: "main", sessionKey: privateKey }, "acl-private-fixture", {
    mode: "source",
  });
});

async function seedGroup(topic: number, sourceBound = true) {
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:telegram:group:-100123:topic:" + topic,
    sessionId: "acl-ws-group-" + topic,
  };
  await seedEntry(scope, scope.sessionId, sourceBound ? { mode: "source" } : undefined);
  await appendTranscriptMessage(scope, {
    eventId: "acl-ws-seed-" + topic,
    message: { role: "user", content: text, timestamp: Date.now() },
  });
  return scope;
}

/** Denied sends must reach admission without the admitted-run helper's model prewarm. */
async function deniedSend(socket: WebSocket, key: string) {
  // Publish current fixture config through the normal RPC helper first.
  expect((await rpcReq(socket, "health")).ok).toBe(true);
  const id = randomUUID();
  const response = onceMessage<Pick<ResponseFrame, "type" | "id" | "ok" | "error">>(
    socket,
    (frame) => frame.type === "res" && frame.id === id,
  );
  socket.send(
    JSON.stringify({
      type: "req",
      id,
      method: "chat.send",
      params: { sessionKey: key, message: "must not run", idempotencyKey: id },
    }),
  );
  return await response;
}

async function expectHiddenSendDenied(
  socket: WebSocket,
  scope: Awaited<ReturnType<typeof seedGroup>>,
) {
  const transcript = loadTranscriptEventsSync(scope);
  const pending = await listSessionPendingInputs(scope);
  const response = await deniedSend(socket, scope.sessionKey);
  expectOpaqueMissing(response, scope.sessionKey);
  expect(await listSessionPendingInputs(scope)).toEqual(pending);
  expect(loadTranscriptEventsSync(scope)).toEqual(transcript);
}

test("refuses an unidentified trusted-proxy connection", async () => {
  const { socket, response } = await openIdentity();
  try {
    expect(response.ok).toBe(false);
  } finally {
    socket.terminate();
  }
});

test.each(["selected", "outsider"] as const)(
  "prevents %s from preclaiming an absent native source",
  async (actor) => {
    const socket = await client(actor);
    const key = "agent:main:telegram:group:-100123:topic:99";
    for (const method of ["sessions.create", "sessions.patch"] as const) {
      const denied = await rpcReq(socket, method, {
        key,
        ...(method === "sessions.patch" ? { label: "preclaim" } : {}),
      });
      expect(denied, method).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      expect(denied.error?.message, method).toContain("trusted ingress");
    }
    const denied = await deniedSend(socket, key);
    expect(denied).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(denied.error?.message).toContain("trusted ingress");
    const absent = await rpcReq<{ session?: unknown }>(await client("admin"), "sessions.describe", {
      key,
    });
    expect(absent.ok, JSON.stringify(absent.error)).toBe(true);
    expect(absent.payload?.session).toBeFalsy();
  },
);

test("publishes a web conversation privately without visual Draft", async () => {
  const key = "agent:main:dashboard:acl-web-created";
  const created = await rpcReq(await client("creator"), "sessions.create", {
    key,
    visibility: "shared",
  });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const described = await describeSession(await client("outsider"), key);
  expect(described.payload?.session?.key).not.toBe(key);
});

test.each(["creator", "selected", "outsider", "admin", "legacy"] as const)(
  "enforces discovery, reads and writes for %s with independent confidential access",
  async (actor) => {
    const topic = ["creator", "selected", "outsider", "admin", "legacy"].indexOf(actor) + 1;
    const scope = await seedGroup(topic, actor !== "legacy");
    const key = scope.sessionKey;
    const socket = await client(actor === "legacy" ? "outsider" : actor);
    const allowed = actor !== "outsider";
    const list = await rpcReq<{ sessions: Array<{ key: string }> }>(socket, "sessions.list", {
      archived: "all",
    });
    expect(list.ok, JSON.stringify(list.error)).toBe(true);
    expect(list.payload?.sessions.some((row) => row.key === key)).toBe(allowed);
    expect(list.payload?.sessions.some((row) => row.key === privateKey)).toBe(
      actor === "creator" || actor === "admin",
    );
    const described = await describeSession(socket, key);
    expect(described.payload?.session?.key === key).toBe(allowed);
    if (allowed) {
      expect(described.payload?.session?.accessMode).toBe(
        actor === "legacy" ? undefined : "source",
      );
    }
    const history = await rpcReq(socket, "chat.history", { sessionKey: key, limit: 10 });
    expect(JSON.stringify(history.payload ?? {}).includes(text)).toBe(allowed);
    const search = await rpcReq(socket, "sessions.search", {
      query: "confidential",
      limit: 25,
      scope: { archived: "all" },
    });
    expect(search.ok, JSON.stringify(search.error)).toBe(true);
    expect(JSON.stringify(search.payload).includes(key)).toBe(allowed);
    expect((await rpcReq(socket, "sessions.patch", { key, label: "acl-write-" + actor })).ok).toBe(
      allowed,
    );
    if (!allowed) {
      await expectHiddenSendDenied(socket, scope);
    }
    if (actor === "legacy") {
      expect(loadSessionEntry(scope)?.access).toBeUndefined();
      expect((await rpcReq(socket, "sessions.messages.subscribe", { key })).ok).toBe(true);
      const event = onceMessage<{
        type: string;
        event?: string;
        payload?: { sessionKey?: string };
      }>(
        socket,
        (frame) =>
          frame.type === "event" &&
          frame.event === "session.message" &&
          frame.payload?.sessionKey === key,
      );
      expect(
        (
          await rpcReq(await client("admin"), "chat.inject", {
            sessionKey: key,
            message: "Legacy audience event",
          })
        ).ok,
      ).toBe(true);
      expect((await event).payload?.sessionKey).toBe(key);
    }
  },
);

test.each(["access", "rule", "config"] as const)(
  "keeps explicit source access closed after admitted access/rule/config removal: %s",
  async (revocation) => {
    const scope = await seedGroup({ access: 8, rule: 9, config: 10 }[revocation]);
    const { sessionKey: key, sessionId } = scope;
    let member = await client("selected");
    try {
      const access = { key, expectedSessionId: sessionId, access: { mode: "creator" } };
      const before = await rpcReq(member, "chat.history", { sessionKey: key, limit: 10 });
      expect(JSON.stringify(before.payload ?? {}).includes(text)).toBe(true);
      const rejected = await rpcReq(member, "sessions.patch", access);
      expect(rejected).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      expect(rejected.error?.message).toContain("Only the session creator or an admin");
      if (revocation === "access") {
        const revoked = await rpcReq(await client("creator"), "sessions.patch", access);
        expect(revoked.ok, JSON.stringify(revoked.error)).toBe(true);
      } else {
        const { getRuntimeConfig, writeConfigFile } = await import("../config/config.js");
        testState.sessionConfig = {
          sharing:
            revocation === "rule"
              ? { accessPolicy: { default: "creator", groups: [] } }
              : undefined,
        };
        await writeConfigFile({
          ...getRuntimeConfig(),
          session: { ...getRuntimeConfig().session, ...testState.sessionConfig },
        });
        expect((await rpcReq(await client("admin"), "health")).ok).toBe(true);
        expect(getRuntimeConfig().session?.sharing?.accessPolicy).toEqual(
          revocation === "rule" ? { default: "creator", groups: [] } : undefined,
        );
        // Minimal Gateways keep initial committed config; a restart admits the new policy.
        await restartFixtureGateway();
        member = await client("selected");
        expect(loadSessionEntry(scope)?.access).toEqual({ mode: "source" });
      }
      const described = await describeSession(member, key);
      expect(described.payload?.session?.key === key, "source-describe-after-" + revocation).toBe(
        false,
      );
      const history = await rpcReq(member, "chat.history", { sessionKey: key, limit: 10 });
      expect(
        JSON.stringify(history.payload ?? {}).includes(text),
        "source-history-after-" + revocation,
      ).toBe(false);
      expect(
        (await rpcReq(member, "sessions.patch", { key, label: "revoked" })).ok,
        "source-patch-after-" + revocation,
      ).toBe(false);
      await expectHiddenSendDenied(member, scope);
    } finally {
      if (revocation !== "access") {
        await configureAccess();
        await restartFixtureGateway();
      }
    }
  },
);

test.for([
  { method: "sessions.send", mode: "audience", topic: 201 },
  { method: "sessions.steer", mode: "audience", topic: 202 },
  { method: "sessions.send", mode: "source", topic: 203 },
  { method: "sessions.steer", mode: "source", topic: 204 },
] as const)(
  "confidential messaging ingress $method ($mode)",
  async ({ method, mode, topic }, { signal }) => {
    const scope =
      mode === "source"
        ? await seedGroup(topic)
        : {
            agentId: "main",
            sessionKey: `agent:main:dashboard:acl-messaging-${topic}`,
            sessionId: `acl-messaging-${topic}`,
          };
    if (mode === "audience") {
      await seedEntry(scope, scope.sessionId, {
        mode: "audience",
        profileIds: [profileIds.get("selected")!],
      });
      await appendTranscriptMessage(scope, {
        eventId: `acl-messaging-seed-${topic}`,
        message: { role: "user", content: text, timestamp: Date.now() },
      });
    }
    const outsider = await client("outsider");
    const before = {
      entry: loadSessionEntry(scope),
      transcript: loadTranscriptEventsSync(scope),
      pending: await listSessionPendingInputs(scope),
      runs: listActiveSessionRunIds(),
    };
    agentCommandMock.mockClear();
    dispatchInboundMessageMock.mockClear();
    gatewayReplyMock.mockClear();
    // Unlike chat.send, rpcReq does not prepare a model runtime for these methods.
    const denied = await rpcReq(outsider, method, {
      key: scope.sessionKey,
      message: "outsider must not enqueue or run",
      idempotencyKey: randomUUID(),
    });
    expectOpaqueMissing(denied, scope.sessionKey);
    expect(denied.payload).toBeUndefined();
    expect(loadSessionEntry(scope)).toEqual(before.entry);
    expect(loadTranscriptEventsSync(scope)).toEqual(before.transcript);
    expect(await listSessionPendingInputs(scope)).toEqual(before.pending);
    expect(listActiveSessionRunIds()).toEqual(before.runs);
    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(gatewayReplyMock).not.toHaveBeenCalled();

    const missingKey =
      mode === "source"
        ? `agent:main:telegram:group:-100123:topic:${topic + 1000}`
        : `${scope.sessionKey}-missing`;
    expect(loadSessionEntry({ agentId: "main", sessionKey: missingKey })).toBeUndefined();
    const absent = await rpcReq(outsider, method, {
      key: missingKey,
      message: "absent target must not enqueue or run",
      idempotencyKey: randomUUID(),
    });
    expect(absent.ok).toBe(false);
    expect(loadSessionEntry({ agentId: "main", sessionKey: missingKey })).toBeUndefined();
    expect(listActiveSessionRunIds()).toEqual(before.runs);
    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(gatewayReplyMock).not.toHaveBeenCalled();
    // The caller-supplied key may be echoed, but row existence must remain hidden.
    const normalize = (error: typeof denied.error, key: string) => {
      const deniedError = expectDefined(error, "RPC denial error");
      return {
        code: deniedError.code,
        message: expectDefined(deniedError.message, "RPC denial message").replaceAll(
          key,
          "<requested-key>",
        ),
      };
    };
    expect
      .soft(
        normalize(denied.error, scope.sessionKey),
        "outsider must not distinguish an existing confidential row from an absent row",
      )
      .toEqual(normalize(absent.error, missingKey));

    // Positive controls retain real RPC/sharing/input owners; only inference is stubbed.
    await prepareGatewayReplyRuntimeForTest();
    for (const actor of ["creator", "selected"] as const) {
      const completed = recordApprovedInput(scope.sessionKey);
      const message = `${method} allowed ${actor} ${mode}`;

      const runId = randomUUID();
      const accepted = await rpcReq(await client(actor), method, {
        key: scope.sessionKey,
        message,
        idempotencyKey: runId,
      });
      expect(accepted, JSON.stringify(accepted.error)).toMatchObject({
        ok: true,
        payload: { runId, status: "started" },
      });
      await withinTest(completed.promise, signal);
      expect(await withinTest(waitForGatewayActiveWork(), signal)).toMatchObject({ drained: true });
      expect(JSON.stringify(loadTranscriptEventsSync(scope))).toContain(message);
    }
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(gatewayReplyMock).not.toHaveBeenCalled();
  },
);

test.for(["sessions.send", "sessions.steer"] as const)(
  "confidential messaging ingress roleless absence and preclaim guard via %s",
  async (method, { signal }) => {
    // Change only this isolated fixture, not any external/staging Gateway.
    for (const socket of people.values()) {
      socket.terminate();
    }
    people.clear();
    await configureBrowserAuth(browserProxyAuth());
    const topic = method === "sessions.send" ? 301 : 302;
    const source = await seedGroup(topic);
    const audience = {
      agentId: "main",
      sessionKey: `agent:main:dashboard:acl-roleless-${topic}`,
      sessionId: `acl-roleless-${topic}`,
    };
    await seedEntry(audience, audience.sessionId, {
      mode: "audience",
      profileIds: [profileIds.get("selected")!],
    });
    const outsider = await client("outsider");
    expect((await rpcReq(outsider, "health")).ok).toBe(true);
    const { getRuntimeConfig } = await import("../config/config.js");
    expect(getRuntimeConfig().gateway?.roles).toBeUndefined();
    const runs = listActiveSessionRunIds();
    agentCommandMock.mockClear();
    dispatchInboundMessageMock.mockClear();
    gatewayReplyMock.mockClear();
    for (const scope of [source, audience]) {
      const before = {
        entry: loadSessionEntry(scope),
        pending: await listSessionPendingInputs(scope),
        transcript: loadTranscriptEventsSync(scope),
      };
      const denied = await rpcReq(outsider, method, {
        key: scope.sessionKey,
        message: "roleless outsider must not write",
        idempotencyKey: randomUUID(),
      });
      expectOpaqueMissing(denied, scope.sessionKey);
      expect(loadSessionEntry(scope)).toEqual(before.entry);
      expect(await listSessionPendingInputs(scope)).toEqual(before.pending);
      expect(loadTranscriptEventsSync(scope)).toEqual(before.transcript);
    }
    const absent = {
      agentId: "main",
      sessionKey: `agent:main:telegram:group:-100123:topic:${topic + 1000}`,
      sessionId: `acl-roleless-absent-${topic}`,
    };
    expect(loadSessionEntry(absent)).toBeUndefined();
    const pending = await listSessionPendingInputs(absent);
    const transcript = loadTranscriptEventsSync(absent);
    for (const actor of ["creator", "selected", "outsider"] as const) {
      const socket = await client(actor);
      const denied = await rpcReq(socket, method, {
        key: absent.sessionKey,
        message: "must not preclaim native namespace",
        idempotencyKey: randomUUID(),
      });
      expectOpaqueMissing(denied, absent.sessionKey);
      const create = await rpcReq(socket, "sessions.create", { key: absent.sessionKey });
      expect(create).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      expect(create.error?.message).toContain("trusted ingress");
      expect(loadSessionEntry(absent)).toBeUndefined();
      expect(await listSessionPendingInputs(absent)).toEqual(pending);
      expect(loadTranscriptEventsSync(absent)).toEqual(transcript);
      expect(listActiveSessionRunIds()).toEqual(runs);
    }
    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(gatewayReplyMock).not.toHaveBeenCalled();

    await prepareGatewayReplyRuntimeForTest();
    const selected = await client("selected");
    for (const scope of [source, audience]) {
      const label = "roleless selected " + method + " " + scope.sessionKey;
      const patched = await rpcReq(selected, "sessions.patch", { key: scope.sessionKey, label });
      expect(patched, JSON.stringify(patched.error)).toMatchObject({ ok: true });
      expect(loadSessionEntry(scope)?.label).toBe(label);
      const completed = recordApprovedInput(scope.sessionKey);
      const message = "roleless selected may write " + scope.sessionKey;

      const accepted = await rpcReq(selected, method, {
        key: scope.sessionKey,
        message,
        idempotencyKey: randomUUID(),
      });
      expect(accepted, JSON.stringify(accepted.error)).toMatchObject({ ok: true });
      await withinTest(completed.promise, signal);
      expect(await withinTest(waitForGatewayActiveWork(), signal)).toMatchObject({ drained: true });
      expect(JSON.stringify(loadTranscriptEventsSync(scope))).toContain(message);
    }
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
  },
);
