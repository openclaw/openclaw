import { afterEach, expect, test } from "vitest";
import * as registry from "../agents/bash-process-registry.js";
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

function seedProcess(
  scopeKey: string,
  options: Parameters<typeof createProcessSessionFixture>[0] & { agentId?: string },
  finished = false,
) {
  const session = createProcessSessionFixture(options);
  Object.assign(session, { scopeKey, agentId: options.agentId });
  registry.addSession(session);
  if (finished) {
    registry.markExited(session, 0, null, "completed");
  }
  return session;
}

test("sessions.delete purges only completed processes owned by the deleted session", async () => {
  await createSessionStoreDir();
  const requestedKey = "discord:group:retention-proof";
  const canonicalKey = "agent:main:discord:group:retention-proof";
  const sessionId = "sess-retention-delete";
  await writeSessionStore({
    entries: { [requestedKey]: sessionStoreEntry(sessionId) },
  });
  const scopes = [requestedKey, canonicalKey, sessionId, "agent:main:other"];
  scopes.forEach((scope, i) =>
    seedProcess(scope, { id: `finished-${i}`, backgrounded: true }, true),
  );

  const deleted = await directSessionReq("sessions.delete", { key: requestedKey });

  expect(deleted.ok).toBe(true);
  const retained = scopes.map((_, i) => registry.getFinishedSession(`finished-${i}`) !== undefined);
  expect(retained).toEqual([false, false, false, true]);
});

test("sessions.processes.list exposes only owned background processes without consuming output", async () => {
  await seedActiveMainSession();
  await directSessionReq("sessions.describe", { key: "main" });
  const scopeKey = "agent:main:main";
  const running = seedProcess(scopeKey, {
    id: "visible-process",
    agentId: "main",
    backgrounded: true,
    startedAt: 1,
  });
  registry.appendOutput(running, "stdout", "Building the package\n");
  seedProcess(scopeKey, { id: "foreground-process" });
  seedProcess("agent:main:other", { id: "other-process", backgrounded: true });
  seedProcess(scopeKey, { id: "finished-visible", backgrounded: true }, true);

  const listed = await directSessionReq("sessions.processes.list", { key: "main" });

  expect(listed).toMatchObject({
    ok: true,
    payload: {
      sessionId: "sess-main",
      truncated: false,
      processes: [
        {
          processId: "visible-process",
          instanceId: expect.any(String),
          tail: "Building the package\n",
          status: "running",
        },
        { processId: "finished-visible" },
      ],
    },
  });
  expect(registry.prepareSessionPoll(running, undefined).output).toBe("Building the package\n");
  expect(running.terminalPollObserved).toBeUndefined();
});
