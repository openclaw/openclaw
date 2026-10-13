import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { closeOpenClawAgentDatabasesAsync } from "./openclaw-agent-db-lifecycle.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import type { OpenClawAgentDatabaseExecution } from "./openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import {
  openOpenClawAgentSqliteWorkerStoreV2,
  type OpenClawAgentSqliteWorkerStoreV2,
} from "./openclaw-agent-worker-store.js";
import { agentWorkerStoreFixtureEntrypoint } from "./openclaw-agent-worker-store.runtime.test-support.js";
import type { AgentWorkerFixtureOperations } from "./openclaw-agent-worker-store.test-support.js";

const workers = new Set<OpenClawAgentSqliteWorkerStoreV2<AgentWorkerFixtureOperations>>();
const executions = new Set<OpenClawAgentDatabaseExecution>();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await Promise.all([...workers].map((worker) => worker.close()));
    workers.clear();
    await Promise.all([...executions].map((execution) => execution.release()));
    executions.clear();
    await closeOpenClawAgentDatabasesAsync(root);
    closeOpenClawAgentDatabasesForTest();
    cleanup();
  }),
);
let root: string;
let options: { agentId: string; path: string };
beforeEach(() => {
  root = fs.realpathSync(tempDirs.make("agent-worker-v2-"));
  options = { agentId: "main", path: path.join(root, "agent.sqlite") };
});

it.each([false, true])(
  "V2 preserves absence and prepares alongside a captured creator: %s",
  async (concurrentCreator) => {
    if (concurrentCreator) {
      executions.add(
        captureOpenClawAgentDatabaseExecution(options, {
          expectedCreationIdentity: readDatabasePathIdentitySync(options.path),
        }),
      );
    }
    const worker = await openOpenClawAgentSqliteWorkerStoreV2<AgentWorkerFixtureOperations>(
      options,
      { version: 2, assertCurrent() {} },
      { moduleUrl: resolveRuntimeWorkerUrl(agentWorkerStoreFixtureEntrypoint), input: undefined },
    );
    workers.add(worker);
    if (!concurrentCreator) {
      expect(
        await worker.executeExisting({ type: "inspect", input: undefined }, () => {}),
      ).toBeUndefined();
    }
    expect(fs.existsSync(options.path)).toBe(false);
    await worker.prepare();
    expect(fs.existsSync(options.path)).toBe(true);
    const { db } = openOpenClawAgentDatabase(options);
    db.exec("CREATE TABLE worker_proof (value TEXT NOT NULL)");
    expect(
      await worker.execute({ type: "append", input: { value: "worker-owned" } }, () => {}),
    ).toBeGreaterThan(0);
    expect(db.prepare("SELECT value FROM worker_proof").all()).toEqual([{ value: "worker-owned" }]);
    await worker.close();
    await expect(worker.prepare()).rejects.toThrow("closed");
    await expect(worker.execute({ type: "inspect", input: undefined }, () => {})).rejects.toThrow(
      "closed",
    );
  },
);

it("V2 retains owner authority through commit even when the operation guard remains current", async () => {
  const { db } = openOpenClawAgentDatabase(options);
  db.exec("CREATE TABLE worker_proof (value TEXT NOT NULL)");
  let current = true;
  const worker = await openOpenClawAgentSqliteWorkerStoreV2<AgentWorkerFixtureOperations>(
    options,
    {
      version: 2,
      assertCurrent() {
        if (!current) {
          throw new Error("V2 owner revoked");
        }
      },
    },
    {
      moduleUrl: resolveRuntimeWorkerUrl(agentWorkerStoreFixtureEntrypoint),
      input: undefined,
      onAdmitted(request) {
        if (request.stage === "transaction") {
          current = false;
        }
      },
    },
  );
  workers.add(worker);
  await expect(
    worker.execute({ type: "append", input: { value: "refused" } }, () => {}),
  ).rejects.toThrow("V2 owner revoked");
  expect(db.prepare("SELECT value FROM worker_proof").all()).toEqual([]);
});
