import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { readAgentDatabaseDeletionSnapshot } from "../../state/agent-deletion-journal.read.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import { createCurrentOpenClawAgentDatabaseFixtures } from "../../state/openclaw-agent-db.test-support.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  captureSessionTranscriptReconcileGeneration,
  closeSessionTranscriptReconcileWorkerPool,
  getSessionTranscriptReconcileWorkerPoolSnapshot,
  runSessionTranscriptReconcileOperation,
} from "./session-transcript-reconcile-pool.js";
import { observeReconcileHostSqlite } from "./session-transcript-reconcile.sql-observer.test-support.js";
import type { SessionTranscriptReconcileWorkerMessage } from "./session-transcript-reconcile.worker.js";

function runDiskTask(context: OpenClawStateWorkerContext, pathname: string) {
  return runSessionTranscriptReconcileOperation(
    captureSessionTranscriptReconcileGeneration(),
    async (operation) => {
      const task = await operation.startTask({
        mode: "disk",
        agentId: "main",
        path: pathname,
        stateDir: context.environment.OPENCLAW_STATE_DIR,
        externallySupervised: true,
        leaseId: randomUUID(),
      });
      const messages: string[] = [];
      task.port.on("message", (message: SessionTranscriptReconcileWorkerMessage) => {
        messages.push(message.type);
        if (message.type === "done" || message.type === "failed") {
          task.port.postMessage({ type: "release" }, []);
        }
      });
      try {
        const release = await task.leaseRelease;
        await task.completion;
        if (release.failure) {
          throw release.failure;
        }
        return messages;
      } finally {
        task.port.close();
        await task.leaseRelease;
      }
    },
    { agentId: "main", path: pathname },
  );
}

function observe(context: OpenClawStateWorkerContext, agentPath: string) {
  return observeReconcileHostSqlite({
    data: [context.admission.databasePath, agentPath],
  });
}

it.each([false, true])(
  "initializes runtime without inventing deletion history for a custom agent, serving Gateway owner=%s",
  async (owned) => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "reconcile-first-creation" },
      async (state) => {
        const agentPath = state.path("agent", "agent.sqlite");
        createCurrentOpenClawAgentDatabaseFixtures(state.path("template.sqlite"), [
          { agentId: "main", path: agentPath },
        ]);
        const originalBytes = fs.readFileSync(agentPath);
        const context = captureOpenClawStateWorkerContext();
        expect(context.admission.identity.key).toMatch(/^path:/u);
        expect(fs.existsSync(context.admission.databasePath)).toBe(false);
        const parent = owned
          ? acquireGatewayStateOwner({
              databasePath: context.admission.databasePath,
              payload: {
                pid: process.pid,
                createdAt: new Date().toISOString(),
                configPath: state.configPath,
                stateDir: state.stateDir,
                role: "gateway",
              },
            })
          : undefined;
        const observation = observe(context, agentPath);
        try {
          await expect(runDiskTask(context, agentPath)).resolves.toEqual([
            "done",
            "lease-released",
          ]);
          context.admission.assertCurrent();
          expect(context.admission.identity).toEqual(
            readDatabasePathIdentitySync(context.admission.databasePath),
          );
          expect(context.admission.identity.key).toMatch(/^file:/u);
          await closeSessionTranscriptReconcileWorkerPool();
          expect(observation.calls).toEqual([]);
          expect(Object.values(observation.counts())).toEqual(Array(8).fill(0));
        } finally {
          await closeSessionTranscriptReconcileWorkerPool();
          observation.restore();
          parent?.release();
        }
        expect(
          readAgentDatabaseDeletionSnapshot(context.environment, "runtime")?.retainedDeletions,
        ).toMatchObject({ status: "unavailable", cause: "missing" });
        expect(fs.readFileSync(agentPath)).toEqual(originalBytes);
      },
    );
  },
);

it("refuses an agent replacement during canonical first creation", async () => {
  await withOpenClawTestState(
    { scenario: "external-service", label: "reconcile-creation-replacement" },
    async (state) => {
      const agentPath = state.path("agent", "agent.sqlite");
      const retainedPath = state.path("retained-agent.sqlite");
      createCurrentOpenClawAgentDatabaseFixtures(state.path("template.sqlite"), [
        { agentId: "main", path: agentPath },
      ]);
      const context = captureOpenClawStateWorkerContext();
      const original = readDatabasePathIdentitySync(agentPath);
      const prepare = stateWorker.runOpenClawStateWorkerOperation;
      let replaced = false;
      const creation = vi
        .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
        .mockImplementation(async (...args) => {
          const result = await prepare(...args);
          fs.renameSync(agentPath, retainedPath);
          fs.copyFileSync(retainedPath, agentPath, fs.constants.COPYFILE_EXCL);
          replaced = true;
          return result;
        });
      const observation = observe(context, agentPath);
      try {
        await expect(runDiskTask(context, agentPath)).rejects.toThrow();
        expect(replaced).toBe(true);
        expect(readDatabasePathIdentitySync(agentPath).key).not.toBe(original.key);
        await closeSessionTranscriptReconcileWorkerPool();
        expect(observation.calls).toEqual([]);
      } finally {
        await closeSessionTranscriptReconcileWorkerPool();
        observation.restore();
        creation.mockRestore();
        if (replaced) {
          fs.rmSync(agentPath);
          fs.renameSync(retainedPath, agentPath);
        }
      }
    },
  );
});

it("joins revocation before first creation without dispatching a planner or cleanup task", async () => {
  await withOpenClawTestState(
    { scenario: "external-service", label: "reconcile-creation-revocation" },
    async (state) => {
      const agentPath = state.path("agent", "agent.sqlite");
      createCurrentOpenClawAgentDatabaseFixtures(state.path("template.sqlite"), [
        { agentId: "main", path: agentPath },
      ]);
      const context = captureOpenClawStateWorkerContext();
      const entered = createDeferred();
      const resume = createDeferred();
      const prepare = stateWorker.runOpenClawStateWorkerOperation;
      const creation = vi
        .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
        .mockImplementation(async (...args) => {
          entered.resolve();
          await resume.promise;
          return prepare(...args);
        });
      const observation = observe(context, agentPath);
      const task = runDiskTask(context, agentPath);
      void task.catch(() => {});
      try {
        await entered.promise;
        const closing = closeOpenClawAgentDatabaseByPathAsync(agentPath);
        resume.resolve();
        await expect(task).rejects.toThrow("reconciliation was revoked");
        await closing;
        expect(fs.existsSync(context.admission.databasePath)).toBe(false);
        expect(getSessionTranscriptReconcileWorkerPoolSnapshot().workersCreated).toBe(0);
        expect(observation.calls).toEqual([]);
      } finally {
        resume.resolve();
        await task.catch(() => {});
        await closeSessionTranscriptReconcileWorkerPool();
        observation.restore();
        creation.mockRestore();
      }
    },
  );
});
