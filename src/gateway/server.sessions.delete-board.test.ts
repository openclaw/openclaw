import { afterEach, expect, test } from "vitest";
import { SqliteBoardStore } from "../boards/sqlite-board-store.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
  writeSingleLineSession,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

test("sessions.delete removes the session board from its agent database", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-board", "hello");
  await writeSessionStore({
    entries: {
      "discord:group:board-delete": sessionStoreEntry("sess-board"),
    },
  });
  const sessionKey = "agent:main:discord:group:board-delete";
  const store = new SqliteBoardStore({
    resolveAgentId: () => "main",
    env: process.env,
  });
  store.putWidget({
    sessionKey,
    name: "status",
    content: { kind: "html", html: "ok" },
  });

  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
    key: "discord:group:board-delete",
  });

  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(true);
  expect(store.getSnapshot(sessionKey)).toEqual({
    sessionKey,
    revision: 0,
    tabs: [],
    widgets: [],
  });
});
