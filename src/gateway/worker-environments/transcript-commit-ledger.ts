import type { OpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { createPlacementWorkerMutation } from "./placement-worker-mutation.js";
import {
  isWorkerTranscriptCommitBeginResult,
  isWorkerTranscriptCommitOutcome,
  type WorkerTranscriptCommitInput,
  type WorkerTranscriptCommitOutcome,
  type WorkerTranscriptCommitOperations,
} from "./transcript-commit-store.worker-contract.js";

export type {
  WorkerTranscriptCommitInput,
  WorkerTranscriptCommitOutcome,
} from "./transcript-commit-store.worker-contract.js";

export function createWorkerTranscriptCommitStore(
  options: { database?: OpenClawStateDatabase; now?: () => number } = {},
) {
  const context = captureOpenClawStateWorkerContext({ path: options.database?.path });
  const now = options.now ?? Date.now;
  const execute = <Key extends keyof WorkerTranscriptCommitOperations>(
    command: { type: Key; input: WorkerTranscriptCommitOperations[Key]["input"] },
    readReceipt: (facts: unknown) => WorkerTranscriptCommitOperations[Key]["output"] | undefined,
    assertCurrent?: () => void,
  ): Promise<WorkerTranscriptCommitOperations[Key]["output"]> => {
    // Capture caller-owned payloads before admission can yield to another operation.
    const captured = structuredClone(command);
    return createPlacementWorkerMutation({
      context,
      label: "Worker transcript ledger",
      nativeLocation: context.admission.databasePath,
      assertCurrent,
      stageCommit: () => undefined,
      readReceipt,
    }).run((scope) => scope.execute(captured));
  };
  return {
    begin(input: WorkerTranscriptCommitInput, assertCurrent?: () => void) {
      return execute(
        { type: "placementTranscript.begin", input: { ...input, nowMs: now() } },
        (facts) => (isWorkerTranscriptCommitBeginResult(facts) ? facts : undefined),
        assertCurrent,
      );
    },
    complete(
      input: WorkerTranscriptCommitInput & { outcome: WorkerTranscriptCommitOutcome },
      assertCurrent?: () => void,
    ) {
      return execute(
        { type: "placementTranscript.complete", input: { ...input, nowMs: now() } },
        (facts) => (isWorkerTranscriptCommitOutcome(facts) ? facts : undefined),
        assertCurrent,
      );
    },
    async discardUncommitted(input: WorkerTranscriptCommitInput): Promise<void> {
      // Known rollback cleanup retains the fresh claim, even after caller revocation.
      // Physical store admission and the exact pending-row predicate still apply.
      await execute(
        { type: "placementTranscript.discard", input: { ...input, nowMs: now() } },
        (facts) => (facts === true ? facts : undefined),
      );
    },
  };
}

export type WorkerTranscriptCommitStore = ReturnType<typeof createWorkerTranscriptCommitStore>;
