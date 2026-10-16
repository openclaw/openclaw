/**
 * Gateway lifecycle proof for session-scoped completed process cleanup.
 */
import { afterEach, expect, test } from "vitest";
import {
  addSession,
  appendOutput,
  getFinishedSession,
  markExited,
} from "../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../agents/bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, seedActiveMainSession } = setupGatewaySessionsHandlerTestHarness();

afterEach(async () => {
  await disposeSessionReadContexts();
  resetProcessRegistryForTests();
  await closeStateDatabaseForTest();
});

function seedFinishedProcess(id: string, scopeKey: string) {
  const session = createProcessSessionFixture({ id, backgrounded: true });
  session.scopeKey = scopeKey;
  addSession(session);
  markExited(session, 0, null, "completed");
}

test("sessions.delete purges only completed processes owned by the deleted session", async () => {
  await createSessionStoreDir();
  const requestedKey = "discord:group:retention-proof";
  const canonicalKey = "agent:main:discord:group:retention-proof";
  const sessionId = "sess-retention-delete";
  await writeSessionStore({
    entries: { [requestedKey]: sessionStoreEntry(sessionId) },
  });
  seedFinishedProcess("finished-delete-alias", requestedKey);
  seedFinishedProcess("finished-delete-canonical", canonicalKey);
  seedFinishedProcess("finished-delete-id", sessionId);
  seedFinishedProcess("finished-delete-other", "agent:main:other");

  const deleted = await directSessionReq("sessions.delete", { key: requestedKey });

  expect(deleted.ok).toBe(true);
  expect(getFinishedSession("finished-delete-alias")).toBeUndefined();
  expect(getFinishedSession("finished-delete-canonical")).toBeUndefined();
  expect(getFinishedSession("finished-delete-id")).toBeUndefined();
  expect(getFinishedSession("finished-delete-other")).toBeDefined();
});

test("sessions.processes.list exposes only owned background processes without consuming output", async () => {
  await seedActiveMainSession();
  // Prepare the real row projection through its existing read boundary.
  await directSessionReq("sessions.describe", { key: "main" });
  const running = createProcessSessionFixture({
    id: "visible-process",
    command: "node build.mjs",
    backgrounded: true,
    startedAt: 1,
  });
  running.scopeKey = "agent:main:main";
  running.agentId = "main";
  addSession(running);
  appendOutput(running, "stdout", "Building the package\n");
  const foreground = createProcessSessionFixture({ id: "foreground-process" });
  foreground.scopeKey = running.scopeKey;
  addSession(foreground);
  const unrelated = createProcessSessionFixture({ id: "other-process", backgrounded: true });
  unrelated.scopeKey = "agent:main:other";
  addSession(unrelated);
  seedFinishedProcess("finished-visible", running.scopeKey);

  const listed = await directSessionReq<{
    sessionId: string;
    processes: Array<{ processId: string; instanceId: string; tail: string; status: string }>;
    truncated: boolean;
  }>("sessions.processes.list", { key: "main" });

  expect(listed.ok).toBe(true);
  expect(listed.payload).toMatchObject({ sessionId: "sess-main", truncated: false });
  expect(listed.payload?.processes.map((row) => row.processId)).toEqual([
    "visible-process",
    "finished-visible",
  ]);
  expect(listed.payload?.processes[0]).toMatchObject({
    instanceId: expect.any(String),
    tail: "Building the package\n",
    status: "running",
  });
  expect(running.pendingOutput).toEqual([{ stream: "stdout", text: "Building the package\n" }]);
  expect(running.terminalPollObserved).toBeUndefined();
});
