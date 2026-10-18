import { existsSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import type { WebSocket } from "ws";
import { getRuntimeConfig } from "../config/io.js";
import type { InternalSessionEntry } from "../config/sessions.js";
import { loadCombinedSessionStoreForGatewayCore } from "../config/sessions/combined-store-gateway.native.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { peekSystemEvents } from "../infra/system-events.js";
import {
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  setupSessionCreateTestHarness,
  requireNonEmptyString,
} from "./server.sessions.create.test-support.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";
import { loadGatewayTestConfig } from "./test-helpers.config-runtime.js";
import {
  dispatchInboundMessageMock,
  onceMessage,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import {
  sessionStoreEntry,
  directSessionReq,
  getGatewayConfigModule,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupSessionCreateTestHarness();

type IncognitoResult = { key: string; sessionId: string; entry: InternalSessionEntry };
type SessionList = { sessions: Array<{ key: string; incognito?: true }> };

async function createSession(params: Record<string, unknown>, ws?: WebSocket) {
  const input = { agentId: "main", ...params };
  const result = ws
    ? await rpcReq<IncognitoResult>(ws, "sessions.create", input)
    : await directSessionReq<IncognitoResult>("sessions.create", input);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  requireNonEmptyString(result.payload?.key, "created session key");
  return result.payload!;
}

function durableRow(storePath: string, sessionKey: string, agentId = "main") {
  const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId });
  const { db } = openOpenClawAgentDatabase({ agentId, path: target.path });
  return db
    .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
    .get(sessionKey);
}

async function expectInvalidCreate(params: Record<string, unknown>, message: string) {
  expect(await directSessionReq("sessions.create", { agentId: "main", ...params })).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message },
  });
}

async function expectNotListed(key: string, ws?: WebSocket) {
  const listed = ws
    ? await rpcReq<SessionList>(ws, "sessions.list", {})
    : await directSessionReq<SessionList>("sessions.list", {});
  expect(listed.ok).toBe(true);
  expect(listed.payload?.sessions.some((session) => session.key === key)).toBe(false);
}

function closeIncognitoSessions() {
  memorySessionActorOwners.list().forEach((owner) => memorySessionActorOwners.closeDatabase(owner));
}

test("sessions.create keeps incognito rows process-local through list, spawn, reset, and delete", async () => {
  const { storePath } = await createSessionStoreDir();
  const read = (sessionKey: string) => loadSessionEntry({ agentId: "main", sessionKey });
  try {
    await writeSessionStore({ entries: { main: sessionStoreEntry("durable-parent") } });
    const { key, entry } = await createSession({ incognito: true });
    expect(key).toMatch(/^agent:main:dashboard:incognito-/u);
    expect(peekSystemEvents("agent:main:main")).toEqual([]);
    expect(entry?.incognito).toBe(true);
    expect(entry?.parentSessionKey).toBeUndefined();
    expect(entry).not.toHaveProperty("sessionFile");
    const incognitoPath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
    expect(existsSync(incognitoPath)).toBe(false);
    expect(read(key)?.incognito).toBe(true);
    expect(loadCombinedSessionStoreForGatewayCore(getRuntimeConfig()).store[key]?.incognito).toBe(
      true,
    );
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.incognito).toBe(true);
    expect(durableRow(storePath, key)).toBeUndefined();

    await expectInvalidCreate(
      { incognito: true, parentSessionKey: "main" },
      "incognito sessions cannot have durable parents",
    );

    await expectNotListed(key);

    await expectInvalidCreate({ key }, "incognito-shaped session keys require incognito: true");
    expect(read(key)?.sessionId).toBe(entry?.sessionId);

    const child = await createSession({ parentSessionKey: key });
    const childKey = child.key;
    expect(child.entry).toMatchObject({
      incognito: true,
      parentSessionKey: key,
      parentSessionId: entry?.sessionId,
    });
    expect(child.entry).not.toHaveProperty("sessionFile");

    const durableSubagentKey = "agent:main:subagent:durable-existing";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: durableSubagentKey, storePath },
      { sessionId: "durable-subagent", updatedAt: Date.now() },
    );
    await expectInvalidCreate(
      { key: durableSubagentKey, parentSessionKey: key },
      "incognito sessions are web-only",
    );
    expect(durableRow(storePath, durableSubagentKey)).toEqual({
      current_session_id: "durable-subagent",
    });

    expect((await directSessionReq("sessions.delete", { key: childKey })).payload).toMatchObject({
      archived: [],
      deleted: true,
    });

    const reset = await directSessionReq<{ deleted?: boolean }>("sessions.reset", { key });
    expect(reset.payload).toMatchObject({ deleted: true });
    expect(
      (await resolveGatewaySessionStoreTargetInWorker({ cfg: getRuntimeConfig(), key })).storePath,
    ).toBe(incognitoPath);
    expect(read(key)).toBeUndefined();
    expect(read(childKey)).toBeUndefined();
    expect(existsSync(incognitoPath)).toBe(false);
    await expectNotListed(key);

    for (const suffix of ["discord:channel:123", "subagent:incognito-client-key"]) {
      await expectInvalidCreate(
        { key: `agent:main:${suffix}`, incognito: true },
        "incognito sessions are web-only",
      );
    }
    await expectInvalidCreate(
      { key: "agent:work:dashboard:incognito-client-key", incognito: true },
      'agent "main" does not match session key agent "work"',
    );
  } finally {
    closeIncognitoSessions();
  }
});

test("incognito webchat rejects a vanished non-default-agent session before dispatch", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentsConfig = { entries: { main: {}, work: {} } };
  await (await getGatewayConfigModule()).writeConfigFile(loadGatewayTestConfig());
  const { ws } = await openClient({
    browserOrigin: "http://127.0.0.1",
    client: {
      id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      version: "dev",
      platform: "web",
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
    },
  });
  try {
    const created = await createSession({ agentId: "work", incognito: true }, ws);
    const sessionKey = created.key;
    const sessionId = requireNonEmptyString(created.sessionId, "incognito webchat id");

    closeIncognitoSessions();
    dispatchInboundMessageMock.mockClear();
    const stale = await rpcReq(ws, "chat.send", {
      sessionKey,
      sessionId,
      message: "this must not persist after restart",
      idempotencyKey: "stale-incognito-webchat-send",
    });
    expect(stale).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: `Incognito session "${sessionKey}" was not found.`,
      },
    });
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(memorySessionActorOwners.list()).toEqual([]);

    expect(durableRow(storePath, sessionKey, "work")).toBeUndefined();
  } finally {
    ws.close();
    closeIncognitoSessions();
  }
});

test("createGatewaySession rechecks admin scope after incognito inheritance resolves", async () => {
  await createSessionStoreDir();
  try {
    const { createGatewaySession } = await import("./session-create-service.js");
    const { key: parentSessionKey } = await createSession({ incognito: true });
    const base = {
      cfg: getRuntimeConfig(),
      agentId: "main",
      parentSessionKey,
      commandSource: "test",
    };

    await expect(
      createGatewaySession({ ...base, requestingOperatorScopes: ["operator.write"] }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "incognito sessions require gateway scope: operator.admin",
      },
    });
    await expect(
      createGatewaySession({ ...base, requestingOperatorScopes: ["operator.admin"] }),
    ).resolves.toMatchObject({ ok: true, entry: { incognito: true } });
  } finally {
    closeIncognitoSessions();
  }
});

test("incognito operator RPCs treat identityless connections as owner-equivalent", async () => {
  testState.agentsConfig = { entries: { main: {} } };
  const { dir } = await createSessionStoreDir();
  const connect = (name: string, scope: string) =>
    openClient({
      scopes: [scope],
      deviceIdentityPath: path.join(dir, `${name}-device.json`),
    });
  const admin = await connect("admin", "operator.admin");
  const reader = await connect("reader", "operator.read");
  const writer = await connect("writer", "operator.write");
  try {
    const { key: sessionKey } = await createSession({ incognito: true }, admin.ws);

    await expectNotListed(sessionKey, admin.ws);

    for (const ws of [admin.ws, reader.ws, writer.ws]) {
      await expect(rpcReq(ws, "sessions.subscribe", {})).resolves.toMatchObject({ ok: true });
    }
    for (const ws of [reader.ws, writer.ws]) {
      await expectNotListed(sessionKey, ws);
    }

    for (const params of [
      { agentId: "main", incognito: true },
      { parentSessionKey: sessionKey },
      { parentSessionKey: sessionKey, fork: true },
      { parentSessionKey: sessionKey, spawnDepth: 1 },
      { parentSessionKey: sessionKey, succeedsParent: false, emitCommandHooks: true },
    ]) {
      await expect(rpcReq(writer.ws, "sessions.create", params)).resolves.toMatchObject({
        ok: false,
        error: { message: "missing scope: operator.admin" },
      });
    }
    await expect(
      rpcReq(admin.ws, "sessions.create", { parentSessionKey: sessionKey }),
    ).resolves.toMatchObject({ ok: true, payload: { entry: { incognito: true } } });

    await expect(rpcReq(reader.ws, "sessions.get", { key: sessionKey })).resolves.toMatchObject({
      ok: true,
    });

    const changedEvent = (ws: typeof admin.ws) =>
      onceMessage(
        ws,
        (message) =>
          message.type === "event" &&
          message.event === "sessions.changed" &&
          (message.payload as { sessionKey?: unknown } | undefined)?.sessionKey === sessionKey,
      );
    const changedEvents = [admin.ws, reader.ws, writer.ws].map(changedEvent);
    const patched = await rpcReq(admin.ws, "sessions.patch", {
      key: sessionKey,
      label: "admin-only",
    });
    expect(patched.ok, JSON.stringify(patched.error)).toBe(true);
    await Promise.all(changedEvents);
  } finally {
    for (const { ws } of [admin, reader, writer]) {
      ws.close();
    }
    closeIncognitoSessions();
  }
});
