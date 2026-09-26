import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { stopChildProcess } from "../../../test/helpers/stop-child-process.js";
import { acquireStateDatabaseCoordinator } from "../../infra/state-database-coordinator.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { measureSessionPhysicalDiskUsage } from "./disk-budget.js";
import { createSessionHistoryBudgetFixture } from "./session-history-budget.test-support.js";
import { enforceSqliteSessionHistoryDiskBudget } from "./session-history-eviction.js";

let state: OpenClawTestState;
afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await state?.cleanup();
});

it("resumes history eviction after foreign lifecycle custody refuses operation and cleanup", async () => {
  state = await createOpenClawTestState({ prefix: "history-lifecycle-", layout: "state-only" });
  const tempDir = state.sessionsDir();
  fs.mkdirSync(tempDir, { recursive: true });
  const storePath = path.join(tempDir, "sessions.json");
  const fixture = createSessionHistoryBudgetFixture(() => ({ tempDir, storePath }));
  await fixture.createHistoricalTranscript({
    sessionKey: "agent:main:history-lifecycle",
    sessionId: "old-history",
    nextSessionId: "live-history",
    content: "x".repeat(256 * 1024),
    updatedAt: 1,
  });
  fixture.settlePhysicalUsage();
  const agent = fixture.database();
  const shared = openOpenClawStateDatabase({ env: state.env });
  const before = await measureSessionPhysicalDiskUsage(storePath);
  const enforce = () =>
    enforceSqliteSessionHistoryDiskBudget({
      storePath,
      env: state.env,
      mode: "enforce",
      maintenance: { maxDiskBytes: before.totalBytes - 1, highWaterBytes: before.totalBytes - 1 },
    });
  const coordinator = acquireStateDatabaseCoordinator({ databasePath: shared.path });
  const coordinatorPath = coordinator.path;
  coordinator.release();
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import { DatabaseSync } from 'node:sqlite';
        const db = new DatabaseSync(process.argv[1]);
        db.exec('PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE');
        process.send({ ready: true });
        process.once('message', () => {
          db.exec('ROLLBACK');
          db.close();
          process.disconnect();
        });
      `,
      coordinatorPath,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  try {
    const [ready] = await once(child, "message", { signal: AbortSignal.timeout(10_000) });
    expect(ready).toEqual({ ready: true });
    expect(shared.walMaintenance.checkpoint()).toBe(false);
    expect(shared.walMaintenance.health?.error).toContain("state-lifecycle");
    expect(agent.walMaintenance.checkpoint()).toBe(true);
    // Both admission and native cleanup must actually fail before testing recovery.
    await expect(enforce()).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ name: "StateDatabaseCoordinatorContentionError" }),
        expect.objectContaining({ name: "StateDatabaseCoordinatorContentionError" }),
      ],
    });
  } finally {
    if (child.connected) {
      child.send({ release: true });
    }
    try {
      if (child.exitCode === null) {
        await once(child, "close", { signal: AbortSignal.timeout(5_000) });
      }
    } finally {
      await stopChildProcess(child, 5_000);
    }
  }
  const result = await enforce();
  expect(result?.deferredReason).toBeUndefined();
  expect(result?.removedEntries).toBe(1);
  expect(result?.freedBytes).toBeGreaterThan(0);
  expect(fixture.sessionExists("old-history")).toBe(false);
  expect(fixture.sessionExists("live-history")).toBe(true);
});
