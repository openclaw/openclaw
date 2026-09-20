/** Gateway durable session-face behavior. */
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { SqliteBoardStore } from "../boards/sqlite-board-store.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.entry.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  listOpenIncognitoAgentDatabases,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { boardStore } from "./board-store.js";
import { rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

test("a write-scoped face patch is visible to another client", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: { sessionId: "sess-main", updatedAt: Date.now() },
    },
  });

  const firstClient = await openClient({ scopes: ["operator.read", "operator.write"] });
  try {
    const patched = await rpcReq<{ ok: true; entry: { boardFace?: string } }>(
      firstClient.ws,
      "sessions.patch",
      { key: "agent:main:main", boardFace: "dashboard" },
    );
    expect(patched.ok).toBe(true);
    expect(patched.payload?.entry.boardFace).toBe("dashboard");

    const unknownField = await rpcReq(firstClient.ws, "sessions.patch", {
      key: "agent:main:main",
      futureFace: "dashboard",
    });
    expect(unknownField.ok).toBe(false);
    expect(unknownField.error?.message).toContain("missing scope: operator.admin");
  } finally {
    firstClient.ws.close();
  }

  const secondClient = await openClient({ scopes: ["operator.read"] });
  try {
    const listed = await rpcReq<{ sessions: Array<{ key: string; boardFace?: string }> }>(
      secondClient.ws,
      "sessions.list",
      { boardFace: "dashboard" },
    );
    expect(listed.ok).toBe(true);
    expect(listed.payload?.sessions).toMatchObject([
      { key: "agent:main:main", boardFace: "dashboard" },
    ]);
  } finally {
    secondClient.ws.close();
  }
});

test("dashboard defaults persist for another client and clear without changing the board face", async () => {
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard-default";
  await writeSessionStore({
    entries: {
      [key]: { sessionId: "dashboard-default", updatedAt: 1, boardFace: "dashboard" },
    },
  });
  const writer = await openClient({ scopes: ["operator.read", "operator.write"] });
  try {
    const patched = await rpcReq<{ entry: { boardPresentation?: string } }>(
      writer.ws,
      "sessions.patch",
      { key, boardPresentation: "expanded" },
    );
    expect(patched.ok).toBe(true);
    expect(patched.payload?.entry.boardPresentation).toBe("expanded");
    const invalid = await rpcReq(writer.ws, "sessions.patch", {
      key,
      boardPresentation: "fullscreen",
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.error?.code).toBe("INVALID_REQUEST");
  } finally {
    writer.ws.close();
  }

  // Drop the cached handle before the next client reads the durable session row.
  const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
  expect(await closeOpenClawAgentDatabaseByPathAsync(target.path)).toBe(true);
  const reader = await openClient({ scopes: ["operator.read"] });
  try {
    const described = await rpcReq<{ session: { boardPresentation?: string } }>(
      reader.ws,
      "sessions.describe",
      { key },
    );
    expect(described.ok).toBe(true);
    expect(described.payload?.session.boardPresentation).toBe("expanded");
    const listed = await rpcReq<{ sessions: Array<{ key: string; boardPresentation?: string }> }>(
      reader.ws,
      "sessions.list",
      {},
    );
    expect(listed.payload?.sessions).toContainEqual(
      expect.objectContaining({ key, boardPresentation: "expanded" }),
    );
    const resolved = await rpcReq<{ boardPresentation?: string }>(reader.ws, "sessions.resolve", {
      reference: { key },
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.payload?.boardPresentation).toBe("expanded");
    const denied = await rpcReq(reader.ws, "sessions.patch", { key, boardPresentation: "split" });
    expect(denied.ok).toBe(false);
    expect(denied.error?.message).toContain("missing scope: operator.write");
  } finally {
    reader.ws.close();
  }

  const clearer = await openClient({ scopes: ["operator.read", "operator.write"] });
  try {
    const cleared = await rpcReq<{ entry: { boardFace?: string; boardPresentation?: string } }>(
      clearer.ws,
      "sessions.patch",
      { key, boardPresentation: null },
    );
    expect(cleared.ok).toBe(true);
    expect(cleared.payload?.entry.boardPresentation).toBeUndefined();
    expect(cleared.payload?.entry.boardFace).toBe("dashboard");
    expect(await closeOpenClawAgentDatabaseByPathAsync(target.path)).toBe(true);
    const entry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
    expect(entry?.boardFace).toBe("dashboard");
    expect(entry).not.toHaveProperty("boardPresentation");
    const described = await rpcReq<{ session: { boardPresentation?: string } }>(
      clearer.ws,
      "sessions.describe",
      { key },
    );
    expect(described.ok).toBe(true);
    expect(described.payload?.session).not.toHaveProperty("boardPresentation");
    const listed = await rpcReq<{ sessions: Array<{ key: string; boardPresentation?: string }> }>(
      clearer.ws,
      "sessions.list",
      {},
    );
    expect(listed.ok).toBe(true);
    expect(listed.payload?.sessions.find((session) => session.key === key)).not.toHaveProperty(
      "boardPresentation",
    );
  } finally {
    clearer.ws.close();
  }
});

test("sessions.list applies face filtering before pagination", async () => {
  await createSessionStoreDir();
  const now = Date.now();
  await writeSessionStore({
    entries: {
      ...Object.fromEntries(
        Array.from({ length: 51 }, (_, index) => [
          `chat-${index}`,
          { sessionId: `sess-chat-${index}`, updatedAt: now - index },
        ]),
      ),
      dashboard: {
        sessionId: "sess-dashboard",
        updatedAt: now - 10_000,
        boardFace: "dashboard",
      },
    },
  });

  const listed = await directSessionReq<{
    sessions: Array<{ key: string; boardFace?: string }>;
    totalCount: number;
  }>("sessions.list", { boardFace: "dashboard", limit: 50 });

  expect(listed.ok).toBe(true);
  expect(listed.payload?.totalCount).toBe(1);
  expect(listed.payload?.sessions).toEqual([
    expect.objectContaining({ key: "agent:main:dashboard", boardFace: "dashboard" }),
  ]);
});

test("sessions.list filters dashboard sessions by board existence instead of saved face", async () => {
  await createSessionStoreDir();
  const now = Date.now();
  await writeSessionStore({
    entries: {
      board: {
        sessionId: "sess-board",
        updatedAt: now,
        boardFace: "chat",
      },
      faceOnly: {
        sessionId: "sess-face-only",
        updatedAt: now - 1,
        boardFace: "dashboard",
      },
    },
  });
  await boardStore.applyOps({ sessionKey: "agent:main:board" }, [
    { kind: "tab_create", tabId: "main", title: "Dashboard" },
  ]);

  const listed = await directSessionReq<{
    sessions: Array<{ key: string; boardFace?: string }>;
    totalCount: number;
  }>("sessions.list", { hasBoard: true, limit: 50 });

  expect(listed.ok).toBe(true);
  expect(listed.payload?.totalCount).toBe(1);
  expect(listed.payload?.sessions).toEqual([
    expect.objectContaining({ key: "agent:main:board", boardFace: "chat" }),
  ]);

  const withoutBoards = await directSessionReq<{
    sessions: Array<{ key: string }>;
    totalCount: number;
  }>("sessions.list", { hasBoard: false, limit: 50 });
  expect(withoutBoards.ok).toBe(true);
  expect(withoutBoards.payload?.totalCount).toBe(1);
  expect(withoutBoards.payload?.sessions).toEqual([
    expect.objectContaining({ key: "agent:main:faceonly" }),
  ]);
});

test("sessions.list excludes boards stored with incognito sessions", async () => {
  await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:incognito-board";
  const incognitoPath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
  openOpenClawAgentDatabase({ agentId: "main", path: incognitoPath });
  onTestFinished(() => {
    closeOpenClawAgentDatabaseByPath(incognitoPath);
  });
  replaceSessionEntrySync(
    { agentId: "main", sessionKey, storePath: incognitoPath },
    { sessionId: "sess-incognito", updatedAt: 1, incognito: true },
  );
  const incognitoBoardStore = new SqliteBoardStore({
    resolveSession: () => ({ agentId: "main", path: incognitoPath, sessionKey }),
  });
  await incognitoBoardStore.applyOps({ sessionKey }, [
    { kind: "tab_create", tabId: "main", title: "Incognito dashboard" },
  ]);
  expect(listOpenIncognitoAgentDatabases()).toContainEqual({
    agentId: "main",
    storePath: incognitoPath,
  });

  const client = { connect: { scopes: ["operator.admin"] } } as never;
  const unfiltered = await directSessionReq<{ sessions: Array<{ key: string }> }>(
    "sessions.list",
    {},
    { client },
  );
  expect(unfiltered.ok).toBe(true);
  expect(unfiltered.payload?.sessions).toEqual([]);

  const listed = await directSessionReq<{ sessions: Array<{ key: string }> }>(
    "sessions.list",
    { hasBoard: true },
    { client },
  );
  expect(listed.ok).toBe(true);
  expect(listed.payload?.sessions).toEqual([]);
});

test.each(["first", "later"] as const)(
  "sessions.list checks a same-owner sentinel board only in its selected store (board=%s)",
  async (boardStoreName) => {
    const rootStateDir = process.env.OPENCLAW_STATE_DIR;
    if (!rootStateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required for gateway session tests");
    }
    const stateDir = path.join(rootStateDir, `board-selected-store-${boardStoreName}`);
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const firstPath = path.join(stateDir, "a-first.sqlite");
      const laterPath = path.join(stateDir, "z-later.sqlite");
      for (const [storePath, sessionId] of [
        [firstPath, "selected-first"],
        [laterPath, "unselected-later"],
      ] as const) {
        replaceSessionEntrySync(
          { agentId: "main", storePath, sessionKey: "unknown" },
          { sessionId, updatedAt: 1 },
        );
      }
      const boards = new SqliteBoardStore({
        resolveSession: () => ({
          agentId: "main",
          path: boardStoreName === "first" ? firstPath : laterPath,
          sessionKey: "unknown",
        }),
      });
      await boards.applyOps({ sessionKey: "unknown" }, [
        { kind: "tab_create", tabId: "main", title: "Selected-store dashboard" },
      ]);
      testState.agentsConfig = { list: [{ id: "main", default: true }] };
      testState.sessionConfig = {
        store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
      };
      for (const hasBoard of [true, false]) {
        const result = await directSessionReq<{
          sessions: Array<{ key: string; agentId: string; sessionId: string }>;
        }>("sessions.list", { configuredAgentsOnly: true, includeUnknown: true, hasBoard });
        expect(result.ok).toBe(true);
        expect(
          result.payload?.sessions.map(({ key, agentId, sessionId }) => ({
            key,
            agentId,
            sessionId,
          })),
        ).toEqual(
          hasBoard === (boardStoreName === "first")
            ? [{ key: "unknown", agentId: "main", sessionId: "selected-first" }]
            : [],
        );
      }
    });
  },
);
