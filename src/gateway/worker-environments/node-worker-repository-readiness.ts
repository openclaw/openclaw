import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { NODE_WORKER_WORKSPACE_QUIESCENCE_VERSION } from "../../infra/node-runner-inventory.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { SessionRepositoryWorkspaceRecord } from "../../state/session-repository-workspaces.types.js";
import {
  NODE_WORKSPACE_REPOSITORY_COMMAND,
  type NodeWorkerRepositoryPreparationInput,
  type NodeWorkerWorkspaceExecResult,
} from "../../worker/node-workspace-protocol.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import type { WorkerWorkspaceCommand } from "./tunnel-contract.js";

export function nativeRepositoryWorkspaceInput(
  input: import("../../worker/node-workspace-protocol.js").NodeWorkerWorkspaceExecInput,
  command: WorkerWorkspaceCommand,
  node: NodeWorkerSupervisorNodeProof,
) {
  return {
    ...input,
    repositoryPreparation: command.repositoryPreparation,
    ...(node.workerHost.workspaceQuiescence === NODE_WORKER_WORKSPACE_QUIESCENCE_VERSION &&
    !command.legacyQuiescence &&
    !input.quiescence &&
    !input.process &&
    !input.transfer &&
    !input.seed
      ? { nativeProcessOwner: true as const }
      : {}),
  };
}

/** The tunnel carries the node-owned fence; synchronization alone may bypass its wait. */
export function createNodeRepositoryReadiness(params: {
  signal: AbortSignal;
  assertCurrent(this: void): void;
  run(
    command: WorkerWorkspaceCommand & { sessionKey: string },
  ): Promise<NodeWorkerWorkspaceExecResult>;
  onPrepared?: (sessionKey: string) => void;
}) {
  let preparation: NodeWorkerRepositoryPreparationInput | undefined;
  let sessionKey: string | undefined;
  let settled: ReturnType<typeof createDeferredCore<void>> | undefined;
  return {
    async prepare(
      this: void,
      request: {
        sessionKey: string;
        repository: SessionRepositoryWorkspaceRecord;
        assertCurrent(this: void): void;
        signal?: AbortSignal;
      },
    ) {
      request.assertCurrent();
      params.assertCurrent();
      if (sessionKey !== undefined && sessionKey !== request.sessionKey) {
        throw new Error("Repository preparation session changed");
      }
      sessionKey = request.sessionKey;
      preparation = {
        status: "pending",
        workspaceId: request.repository.workspaceId,
        revision: request.repository.revision,
        branch: request.repository.branch,
        ...(request.repository.baseCommit ? { baseCommit: request.repository.baseCommit } : {}),
      };
      settled = createDeferredCore();
      const result = await params.run({
        argv: [NODE_WORKSPACE_REPOSITORY_COMMAND],
        repositoryPreparation: preparation,
        sessionKey,
        transportRetry: "never",
        assertCurrent: request.assertCurrent,
        signal: request.signal,
      });
      request.assertCurrent();
      params.assertCurrent();
      if (result.code !== 0 || result.stdout.trim() !== "pending") {
        throw new Error("Repository readiness boundary is unavailable");
      }
      params.onPrepared?.(sessionKey);
      return result.workspaceDir;
    },
    async settle(this: void, status: "ready" | "failed", baseCommit?: string) {
      if (!preparation || !sessionKey) {
        throw new Error("Repository readiness owner is unavailable");
      }
      if (status === "failed") {
        preparation = { ...preparation, status };
        settled?.resolve();
      }
      try {
        params.assertCurrent();
        const result = await params.run({
          argv: [NODE_WORKSPACE_REPOSITORY_COMMAND],
          repositoryPreparation: { ...preparation, status, ...(baseCommit ? { baseCommit } : {}) },
          sessionKey,
          transportRetry: "never",
        });
        params.assertCurrent();
        if (result.code !== 0 || result.stdout.trim() !== status) {
          throw new Error("Repository readiness publication failed");
        }
        preparation = { ...preparation, status };
        settled?.resolve();
      } catch (error) {
        preparation = { ...preparation, status: "failed" };
        settled?.resolve();
        throw error;
      }
    },
    async wait(this: void, signal?: AbortSignal) {
      if (!settled) {
        return;
      }
      await racePromiseWithAbortSignal(
        settled.promise,
        signal ? AbortSignal.any([signal, params.signal]) : params.signal,
      );
      params.assertCurrent();
      if (preparation?.status !== "ready") {
        throw new Error("Repository preparation failed; this operation did not run");
      }
    },
    async execute(
      command: WorkerWorkspaceCommand,
      run: (
        command: WorkerWorkspaceCommand,
      ) => Promise<import("../../process/exec.js").SpawnResult>,
    ) {
      await this.wait(command.signal);
      command.assertCurrent?.();
      return run(command);
    },
  };
}
