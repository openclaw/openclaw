import { createSqliteWorkerWriteAdmission } from "../infra/sqlite-worker-store.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type { OpenClawStateLeaseContext } from "../state/openclaw-state-lease-context.js";
import { runWithOpenClawStateLeaseWorker } from "../state/openclaw-state-lease-worker-storage.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerOperations } from "../state/openclaw-state-worker-contract.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { prepareTranscriptDateReader } from "./store-date-preparation.js";
import { TranscriptLibraryError } from "./store-read.js";
import type {
  TranscriptExportWriteKey,
  TranscriptReadRequests,
  TranscriptWriteOperations,
} from "./store-worker-contract.js";

/** One captured database generation spans planning, filesystem work, and persistence. */
export function createTranscriptStoreOperation(
  options: Pick<OpenClawStateDatabaseOptions, "env" | "path" | "readOnly">,
  assertOwner?: () => void,
) {
  const context = captureOpenClawStateWorkerContext(options);
  const readOnly = options.readOnly;
  const assertCurrent = () => {
    context.admission.assertCurrent();
    assertOwner?.();
  };
  return {
    assertCurrent,
    databaseOptions: { env: context.environment, path: context.admission.databasePath, readOnly },
    async writeExport<Key extends TranscriptExportWriteKey>(
      type: Key,
      request: TranscriptWriteOperations[Key]["input"],
      lease: OpenClawStateLeaseContext,
    ): Promise<void> {
      const input = { ...structuredClone(request), readOnly };
      assertCurrent();
      await runWithOpenClawStateLeaseWorker(lease, context, (scope, identity) =>
        scope.execute<Key>({ type, input: { ...input, lease: identity } }),
      );
    },
    async read<Key extends keyof TranscriptReadRequests>(
      type: Key,
      request: OpenClawStateWorkerOperations[Key]["input"],
    ): Promise<TranscriptReadRequests[Key]["output"]> {
      const input = structuredClone(request);
      input.readOnly = readOnly;
      const preparation =
        type === "transcripts.readEntries"
          ? prepareTranscriptDateReader(assertCurrent, context.admission.databasePath)
          : { assertCurrent };
      const result = await runOpenClawStateWorkerOperation(
        context,
        (scope) => scope.execute<Key>({ type, input }),
        preparation,
      );
      preparation.assertCurrent();
      if (!result.ok) {
        throw new TranscriptLibraryError(
          result.error.type,
          result.error.message,
          result.error.maxBytes,
        );
      }
      return result.value;
    },
    async write<Key extends keyof TranscriptWriteOperations>(
      type: Key,
      request: TranscriptWriteOperations[Key]["input"],
      assertWriteOwner?: () => void,
    ): Promise<TranscriptWriteOperations[Key]["output"]> {
      const input = { ...structuredClone(request), readOnly };
      const assertWriteCurrent = () => {
        assertCurrent();
        assertWriteOwner?.();
      };
      return runOpenClawStateWorkerOperation(
        context,
        (scope) => scope.execute<Key>({ type, input }),
        {
          assertCurrent: assertWriteCurrent,
          createAdmission: createSqliteWorkerWriteAdmission(assertWriteCurrent, [
            context.admission.databasePath,
          ]),
        },
      );
    },
  };
}

export type TranscriptStoreOperation = ReturnType<typeof createTranscriptStoreOperation>;
