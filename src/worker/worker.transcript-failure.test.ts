import path from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import * as workerServer from "../gateway/server/ws-connection/worker-connection.js";
import { StateDatabaseAdmissionPendingError } from "../infra/gateway-state-owner-record.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { AgentDatabaseExecutionAdmissionClosedError } from "../state/agent-database-admission-error.js";
import {
  AgentDatabaseAdmissionError,
  createAgentDatabaseInspectionRefusal,
} from "../state/agent-database-admission.js";
import {
  captureOpenClawAgentDatabaseAdmissionPublication,
  clearOpenClawAgentDatabaseValidationCache,
  getOpenClawAgentDatabaseValidation,
  invalidateOpenClawAgentDatabaseValidation,
} from "../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { StateDatabaseReadAdmissionInvalidatedError } from "../state/openclaw-state-db-async-lifecycle.js";
import { ComposedGatewayHarness } from "./worker-fault-injection.test-support.js";
import { runWorkerDescriptor } from "./worker.runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function schemaPublicationFailure(kind: "stale" | "malformed"): Error {
  const database = openOpenClawAgentDatabase({
    agentId: "main",
    path: path.join(tempDirs.make("oc-admission-"), "agent.db"),
  });
  try {
    const receipt = getOpenClawAgentDatabaseValidation(database)!;
    const publish = captureOpenClawAgentDatabaseAdmissionPublication(database);
    if (kind === "stale") {
      invalidateOpenClawAgentDatabaseValidation(database.path);
    }
    try {
      publish(receipt.identity, kind === "malformed" ? { ...receipt, schema: undefined } : receipt);
    } catch (error) {
      if (error instanceof Error) {
        return error;
      }
      throw error;
    }
    throw new Error("Expected schema publication to refuse the receipt");
  } finally {
    closeOpenClawAgentDatabaseByPath(database.path);
    clearOpenClawAgentDatabaseValidationCache(database.path);
  }
}

it.each(["storage", "malformed schema receipt"])(
  "fails a worker turn after one deterministic %s failure without reconnecting",
  async (kind) => {
    const warn = vi.fn();
    const attach = workerServer.attachWorkerWsMessageHandler;
    const attachment = vi
      .spyOn(workerServer, "attachWorkerWsMessageHandler")
      .mockImplementation((params) => attach({ ...params, logGateway: { warn } }));
    onTestFinished(() => attachment.mockRestore());
    const harness = await ComposedGatewayHarness.create(tempDirs.make("oc-tf-"));
    const controller = new AbortController();
    let run: ReturnType<typeof runWorkerDescriptor> | undefined;
    try {
      await harness.start();
      const replayed = createDeferred();
      const failure =
        kind === "storage"
          ? new Error("transcript operation failed", {
              cause: new Error("synthetic transcript storage failure"),
            })
          : schemaPublicationFailure("malformed");
      const commit = vi
        .spyOn(harness.serviceValue, "commitTranscript")
        .mockImplementation(async () => {
          if (commit.mock.calls.length > 1) {
            replayed.resolve();
          }
          throw failure;
        });
      run = runWorkerDescriptor(await harness.createDescriptor(), { signal: controller.signal });
      const boundedRun = Promise.race([
        run,
        replayed.promise.then(() => {
          throw new Error("Worker replayed a deterministic transcript failure");
        }),
      ]);

      await expect(boundedRun).rejects.toMatchObject({
        name: "WorkerTranscriptCommitError",
        message: "Worker transcript commit failed; check Gateway logs.",
        response: {
          code: "UNAVAILABLE",
          retryable: false,
          details: { reason: "gateway-unavailable" },
        },
      });
      expect(commit).toHaveBeenCalledOnce();
      expect(harness.connectionCount).toBe(1);
      expect(harness.requestParams("worker.transcript.commit")).toHaveLength(1);
      expect(harness.providerCalls).toBe(0);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(
          kind === "storage"
            ? "transcript operation failed | synthetic transcript storage failure"
            : failure.message,
        ),
      );
    } finally {
      controller.abort(new Error("fixture teardown"));
      await Promise.allSettled([run]);
      await harness.close();
    }
  },
);

it("replays transient transcript failures and completes the run without duplicate messages", async () => {
  const harness = await ComposedGatewayHarness.create(tempDirs.make("oc-tf-"));
  const controller = new AbortController();
  let run: ReturnType<typeof runWorkerDescriptor> | undefined;
  try {
    await harness.start();
    const failures = [
      schemaPublicationFailure("stale"),
      Object.assign(new Error("synthetic busy"), { code: "ERR_SQLITE_ERROR", errcode: 5 }),
      Object.assign(new Error("synthetic locked"), { code: "SQLITE_LOCKED" }),
      new AgentDatabaseExecutionAdmissionClosedError("synthetic retiring owner"),
      new AgentDatabaseAdmissionError(
        createAgentDatabaseInspectionRefusal({
          agentId: "main",
          paths: [],
          reason: "synthetic pending inspection",
          pending: true,
        }),
      ),
      new StateDatabaseAdmissionPendingError(
        harness.sessionTarget.storePath,
        "synthetic maintenance",
      ),
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
    run = runWorkerDescriptor(await harness.createDescriptor(), { signal: controller.signal });

    await expect(run).resolves.toMatchObject({ status: "completed" });
    const requests = harness.requestParams("worker.transcript.commit");
    expect(harness.connectionCount).toBe(failures.length + 2);
    expect(requests).toHaveLength(failures.length + 3);
    for (const replay of requests.slice(1, -1)) {
      expect(replay).toEqual(requests[0]);
    }
    expect(harness.providerCalls).toBe(1);
    const transcript = await SessionManager.openAsync(harness.sessionTarget);
    expect(transcript.getEntries()).toHaveLength(2);
    expect(await run).toMatchObject({ transcriptLeafId: transcript.getLeafId() });
  } finally {
    controller.abort(new Error("fixture teardown"));
    await Promise.allSettled([run]);
    await harness.close();
  }
});
