import path from "node:path";
import { expect, test, vi } from "vitest";
import { getRuntimeConfig } from "../config/io.js";
import { loadCombinedSessionStoreForGatewayCore } from "../config/sessions/combined-store-gateway.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { peekSystemEvents } from "../infra/system-events.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  listOpenIncognitoAgentDatabases,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  setupSessionCreateTestHarness,
  requireNonEmptyString,
} from "./server.sessions.create.test-support.js";
import { resolveGatewaySessionStoreTarget } from "./session-utils.js";
import {
  dispatchInboundMessageMock,
  onceMessage,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import { sessionStoreEntry, directSessionReq } from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupSessionCreateTestHarness();

async function closeIncognitoSessionDatabases() {
  for (const { agentId, storePath } of listOpenIncognitoAgentDatabases()) {
    await closeOpenClawAgentDatabaseByPathAsync(storePath, agentId);
  }
}

test("sessions.create keeps incognito rows process-local through list, spawn, reset, and delete", async () => {
  const { storePath } = await createSessionStoreDir();
  try {
    const durableParentKey = "main";
    const savedPrompt = "unrelated durable prompt for incognito existence checks";
    await writeSessionStore({
      entries: {
        main: {
          ...sessionStoreEntry("durable-parent"),
          skillsSnapshot: { prompt: savedPrompt, skills: [] },
        },
      },
    });
    const created = await directSessionReq<{
      key: string;
      entry: {
        incognito?: true;
        parentSessionKey?: string;
        sessionFile?: string;
        sessionId: string;
      };
    }>("sessions.create", { agentId: "main", incognito: true });
    expect(created.ok).toBe(true);
    const key = requireNonEmptyString(created.payload?.key, "incognito session key");
    expect(key).toMatch(/^agent:main:dashboard:incognito-/u);
    expect(peekSystemEvents("agent:main:main")).toEqual([]);
    const entry = created.payload?.entry;
    expect(entry?.incognito).toBe(true);
    expect(entry?.parentSessionKey).toBeUndefined();
    expect(entry).not.toHaveProperty("sessionFile");
    const openedIncognitoDatabase = openOpenClawAgentDatabase({
      agentId: "main",
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
    });
    expect(
      openedIncognitoDatabase.db
        .prepare("SELECT session_key FROM session_nodes WHERE session_key = ?")
        .get(key),
    ).toEqual({ session_key: key });
    expect(loadSessionEntry({ agentId: "main", sessionKey: key })?.incognito).toBe(true);
    expect(loadCombinedSessionStoreForGatewayCore(getRuntimeConfig()).store[key]?.incognito).toBe(
      true,
    );
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.incognito).toBe(true);
    const persistentDatabase = openOpenClawAgentDatabase({
      agentId: "main",
      path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
    });
    expect(
      persistentDatabase.db
        .prepare("SELECT session_key FROM session_nodes WHERE session_key = ?")
        .get(key),
    ).toBeUndefined();

    const rejectedDurableParent = await directSessionReq("sessions.create", {
      agentId: "main",
      incognito: true,
      parentSessionKey: durableParentKey,
    });
    expect(rejectedDurableParent).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "incognito sessions cannot have durable parents",
      },
    });

    const listed = await directSessionReq<{ sessions: Array<{ key: string; incognito?: true }> }>(
      "sessions.list",
      {},
    );
    expect(listed.payload?.sessions).not.toContainEqual(
      expect.objectContaining({ key, incognito: true }),
    );

    const rejectedReuse = await directSessionReq("sessions.create", {
      agentId: "main",
      key,
    });
    expect(rejectedReuse).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "incognito-shaped session keys require incognito: true",
      },
    });
    expect(loadSessionEntry({ agentId: "main", sessionKey: key })?.sessionId).toBe(
      entry?.sessionId,
    );

    const child = await directSessionReq<{
      key: string;
      entry: {
        incognito?: true;
        parentSessionId?: string;
        parentSessionKey?: string;
        sessionFile?: string;
      };
    }>("sessions.create", { agentId: "main", parentSessionKey: key });
    expect(child.ok).toBe(true);
    const childKey = requireNonEmptyString(child.payload?.key, "incognito child key");
    expect(child.payload?.entry.incognito).toBe(true);
    expect(child.payload?.entry.parentSessionKey).toBe(key);
    expect(child.payload?.entry.parentSessionId).toBe(entry?.sessionId);
    expect(child.payload?.entry).not.toHaveProperty("sessionFile");

    const rejectedInheritedChannel = await directSessionReq("sessions.create", {
      agentId: "main",
      key: "agent:main:discord:channel:inherited",
      parentSessionKey: key,
    });
    expect(rejectedInheritedChannel).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "incognito sessions are web-only" },
    });
    const durableSubagentKey = "agent:main:subagent:durable-existing";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: durableSubagentKey, storePath },
      { sessionId: "durable-subagent", updatedAt: Date.now() },
    );
    const rejectedInheritedExisting = await directSessionReq("sessions.create", {
      agentId: "main",
      key: durableSubagentKey,
      parentSessionKey: key,
    });
    expect(rejectedInheritedExisting).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "incognito sessions are web-only" },
    });
    expect(
      persistentDatabase.db
        .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
        .get(durableSubagentKey),
    ).toEqual({ current_session_id: "durable-subagent" });

    const deleted = await directSessionReq<{ archived: string[]; deleted: boolean }>(
      "sessions.delete",
      { key: childKey },
    );
    expect(deleted.payload).toMatchObject({ archived: [], deleted: true });

    const reset = await directSessionReq<{ deleted?: boolean }>("sessions.reset", { key });
    expect(reset.payload).toMatchObject({ deleted: true });
    expect(resolveGatewaySessionStoreTarget({ cfg: getRuntimeConfig(), key }).storePath).toBe(
      resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
    );
    const incognitoDatabase = openOpenClawAgentDatabase({
      agentId: "main",
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
    });
    for (const table of ["session_nodes", "session_windows", "transcript_events"] as const) {
      expect(incognitoDatabase.db.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({
        count: 0,
      });
    }
    const afterReset = await directSessionReq<{ sessions: Array<{ key: string }> }>(
      "sessions.list",
      {},
    );
    expect(afterReset.payload?.sessions.some((session) => session.key === key)).toBe(false);

    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: key, storePath },
      { sessionId: "rematerialized-incognito", updatedAt: Date.now() },
    );
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.incognito).toBe(
      undefined,
    );
    const resetRematerialized = await directSessionReq<{ deleted?: boolean }>("sessions.reset", {
      key,
    });
    expect(resetRematerialized.payload).toMatchObject({ deleted: true });
    expect(
      openedIncognitoDatabase.db
        .prepare("SELECT session_key FROM session_nodes WHERE session_key = ?")
        .get(key),
    ).toBeUndefined();

    const rejected = await directSessionReq("sessions.create", {
      agentId: "main",
      key: "agent:main:discord:channel:123",
      incognito: true,
    });
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "incognito sessions are web-only" },
    });
    const rejectedSubagentKey = await directSessionReq("sessions.create", {
      agentId: "main",
      key: "agent:main:subagent:incognito-client-key",
      incognito: true,
    });
    expect(rejectedSubagentKey).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "incognito sessions are web-only" },
    });
    const rejectedAgentMismatch = await directSessionReq("sessions.create", {
      agentId: "main",
      key: "agent:work:dashboard:incognito-client-key",
      incognito: true,
    });
    expect(rejectedAgentMismatch).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: 'agent "main" does not match session key agent "work"',
      },
    });
    const durableCollisionKey = "agent:main:dashboard:incognito-durable-collision";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: durableCollisionKey, storePath },
      sessionStoreEntry("durable-collision"),
    );
    const parse = vi.spyOn(JSON, "parse");
    try {
      const rejectedExplicitDashboard = await directSessionReq("sessions.create", {
        agentId: "main",
        key: durableCollisionKey,
        incognito: true,
      });
      expect(parse.mock.calls.some(([json]) => json.includes(savedPrompt))).toBe(false);
      expect(rejectedExplicitDashboard).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "incognito is immutable and requires a new session key",
        },
      });
    } finally {
      parse.mockRestore();
    }
  } finally {
    await closeIncognitoSessionDatabases();
  }
});

test("incognito webchat rejects a vanished non-default-agent session before dispatch", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "work" }] };
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
    const created = await rpcReq<{ key?: string; sessionId?: string }>(ws, "sessions.create", {
      agentId: "work",
      incognito: true,
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const sessionKey = requireNonEmptyString(created.payload?.key, "incognito webchat key");
    const sessionId = requireNonEmptyString(created.payload?.sessionId, "incognito webchat id");

    await closeIncognitoSessionDatabases();
    dispatchInboundMessageMock.mockClear();
    const stale = await rpcReq(ws, "chat.send", {
      sessionKey,
      sessionId,
      message: "this must not persist after restart",
      idempotencyKey: "stale-incognito-webchat-send",
    });
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: `Incognito session "${sessionKey}" was not found.`,
    });
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(listOpenIncognitoAgentDatabases()).toEqual([]);

    const persistentDatabase = openOpenClawAgentDatabase({
      agentId: "work",
      path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "work" }).path,
    });
    expect(
      persistentDatabase.db
        .prepare("SELECT session_key FROM session_nodes WHERE session_key = ?")
        .get(sessionKey),
    ).toBeUndefined();
  } finally {
    ws.close();
    await closeIncognitoSessionDatabases();
  }
});

test("createGatewaySession rechecks admin scope after incognito inheritance resolves", async () => {
  await createSessionStoreDir();
  try {
    const { createGatewaySession } = await import("./session-create-service.js");
    const parent = await directSessionReq<{ key?: string }>("sessions.create", {
      agentId: "main",
      incognito: true,
    });
    const parentSessionKey = requireNonEmptyString(parent.payload?.key, "incognito parent key");
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
    await closeIncognitoSessionDatabases();
  }
});

test("incognito operator RPCs treat identityless connections as owner-equivalent", async () => {
  const { dir } = await createSessionStoreDir();
  const admin = await openClient({
    scopes: ["operator.admin"],
    deviceIdentityPath: path.join(dir, "admin-device.json"),
  });
  const reader = await openClient({
    scopes: ["operator.read"],
    deviceIdentityPath: path.join(dir, "reader-device.json"),
  });
  const writer = await openClient({
    scopes: ["operator.write"],
    deviceIdentityPath: path.join(dir, "writer-device.json"),
  });
  try {
    const created = await rpcReq<{ key?: string; sessionId?: string }>(
      admin.ws,
      "sessions.create",
      { agentId: "main", incognito: true },
    );
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const sessionKey = requireNonEmptyString(created.payload?.key, "admin incognito key");

    const adminList = await rpcReq<{ sessions?: Array<{ key?: string }> }>(
      admin.ws,
      "sessions.list",
      {},
    );
    expect(adminList.ok).toBe(true);
    expect(adminList.payload?.sessions?.some((session) => session.key === sessionKey)).toBe(false);

    for (const ws of [admin.ws, reader.ws, writer.ws]) {
      await expect(rpcReq(ws, "sessions.subscribe", {})).resolves.toMatchObject({ ok: true });
    }
    for (const ws of [reader.ws, writer.ws]) {
      const listed = await rpcReq<{ path?: string; sessions?: Array<{ key?: string }> }>(
        ws,
        "sessions.list",
        {},
      );
      expect(listed.ok).toBe(true);
      expect(listed.payload?.sessions?.some((session) => session.key === sessionKey)).toBe(false);
    }

    const deniedCreate = await rpcReq(writer.ws, "sessions.create", {
      agentId: "main",
      incognito: true,
    });
    expect(deniedCreate).toMatchObject({
      ok: false,
      error: { message: "missing scope: operator.admin" },
    });
    for (const params of [
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
    admin.ws.close();
    reader.ws.close();
    writer.ws.close();
    await closeIncognitoSessionDatabases();
  }
});
