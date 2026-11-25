import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import * as workerServer from "../gateway/server/ws-connection/worker-connection.js";
import { StateDatabaseAdmissionPendingError } from "../infra/gateway-state-owner-record.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import {
  AgentDatabaseExecutionAdmissionClosedError,
  AgentDatabaseSchemaAdmissionChangedError,
  AgentDatabaseSchemaAdmissionInvalidError,
} from "../state/agent-database-admission-error.js";
import * as admission from "../state/agent-database-admission.js";
import { StateDatabaseReadAdmissionInvalidatedError } from "../state/openclaw-state-db-async-lifecycle.js";
import { ComposedGatewayHarness } from "./worker-fault-injection.test-support.js";
import { runWorkerDescriptor } from "./worker.runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type Run = ReturnType<typeof runWorkerDescriptor>;
type Check = (harness: ComposedGatewayHarness, start: () => Run) => Promise<void>;
async function withWorker(check: Check) {
  const harness = await ComposedGatewayHarness.create(tempDirs.make("oc-tf-"));
  const controller = new AbortController();
  let run: Run | undefined;
  try {
    await harness.start();
    await check(harness, async () => {
      run = runWorkerDescriptor(await harness.createDescriptor(), { signal: controller.signal });
      return await run;
    });
  } finally {
    controller.abort(new Error("fixture teardown"));
    await Promise.allSettled([run]);
    await harness.close();
  }
}

// The validation-cache suite proves receipt validity; this suite proves transport policy.
it.each(["storage", "malformed schema receipt"])(
  "fails a worker turn after one deterministic %s failure without reconnecting",
  async (kind) => {
    const warn = vi.fn();
    const attach = workerServer.attachWorkerWsMessageHandler;
    const attachment = vi
      .spyOn(workerServer, "attachWorkerWsMessageHandler")
      .mockImplementation((params) => attach({ ...params, logGateway: { warn } }));
    onTestFinished(() => attachment.mockRestore());
    await withWorker(async (harness, start) => {
      const replayed = createDeferred();
      const failure =
        kind === "storage"
          ? new Error("transcript operation failed", {
              cause: new Error("synthetic transcript storage failure"),
            })
          : new AgentDatabaseSchemaAdmissionInvalidError();
      const commit = vi
        .spyOn(harness.serviceValue, "commitTranscript")
        .mockImplementation(async () => {
          if (commit.mock.calls.length > 1) {
            replayed.resolve();
          }
          throw failure;
        });
      const boundedRun = Promise.race([
        start(),
        replayed.promise.then(() => {
          throw new Error("Worker replayed a deterministic transcript failure");
        }),
      ]);

      const details = { reason: "gateway-unavailable" };
      await expect(boundedRun).rejects.toMatchObject({
        name: "WorkerTranscriptCommitError",
        message: "Worker transcript commit failed; check Gateway logs.",
        response: { code: "UNAVAILABLE", retryable: false, details },
      });
      expect(commit).toHaveBeenCalledOnce();
      expect(harness).toMatchObject({ connectionCount: 1, providerCalls: 0 });
      expect(harness.requestParams("worker.transcript.commit")).toHaveLength(1);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(
          kind === "storage"
            ? "transcript operation failed | synthetic transcript storage failure"
            : failure.message,
        ),
      );
    });
  },
);

it("replays transient transcript failures and completes the run without duplicate messages", async () => {
  await withWorker(async (harness, start) => {
    const pendingInspection = { agentId: "main", paths: [], reason: "pending", pending: true };
    const storePath = harness.sessionTarget.storePath;
    const failures = [
      new AgentDatabaseSchemaAdmissionChangedError(),
      Object.assign(new Error("synthetic busy"), { code: "ERR_SQLITE_ERROR", errcode: 5 }),
      Object.assign(new Error("synthetic locked"), { code: "SQLITE_LOCKED" }),
      new AgentDatabaseExecutionAdmissionClosedError("synthetic retiring owner"),
      new admission.AgentDatabaseAdmissionError(
        admission.createAgentDatabaseInspectionRefusal(pendingInspection),
      ),
      new StateDatabaseAdmissionPendingError(storePath, "synthetic maintenance"),
      new StateDatabaseReadAdmissionInvalidatedError("synthetic replaced admission"),
      new SqliteWorkerError("synthetic broker overload", "overloaded"),
      new SqliteWorkerError("synthetic broker retirement", "closed"),
      new SqliteWorkerError("synthetic worker loss", "unavailable"),
      new DOMException("synthetic operation cancellation", "AbortError"),
    ];
    const apply = harness.serviceValue.commitTranscript;
    const commit = vi.spyOn(harness.serviceValue, "commitTranscript");
    for (const failure of failures) {
      commit.mockRejectedValueOnce(failure);
    }
    commit.mockImplementationOnce(async (...args) => {
      await apply(...args);
      throw new SqliteWorkerError("synthetic lost commit receipt", "outcome-unknown");
    });
    const run = start();

    await expect(run).resolves.toMatchObject({ status: "completed" });
    const requests = harness.requestParams("worker.transcript.commit");
    expect(harness).toMatchObject({ connectionCount: failures.length + 2, providerCalls: 1 });
    expect(requests).toHaveLength(failures.length + 3);
    for (const replay of requests.slice(1, -1)) {
      expect(replay).toEqual(requests[0]);
    }
    const transcript = await SessionManager.openAsync(harness.sessionTarget);
    expect(transcript.getEntries()).toHaveLength(2);
    expect(await run).toMatchObject({ transcriptLeafId: transcript.getLeafId() });
  });
});
