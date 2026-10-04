import { vi } from "vitest";
import type { withSessionStoreReaderInWorker } from "./session-entry-read-runtime.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target-paths.js";
import * as workerReaders from "./session-transcript-worker-readers.js";
import type {
  SessionHistoryWorkerDatabase,
  SessionTranscriptWorkerValues,
} from "./session-transcript-worker.types.js";

type StoreSummary = SessionTranscriptWorkerValues["session-store-summary"]["summary"];
type StoreReadScope = Parameters<typeof withSessionStoreReaderInWorker>[0];
type SummaryRequest = Parameters<SessionHistoryWorkerDatabase["readStoreSummary"]>[0];

/** Formatting and deadline fixtures supply rows without opening a database or worker. */
export function createSessionStoreSummaryReaderStub(
  readSummary: (
    scope: StoreReadScope,
    request: SummaryRequest,
  ) => StoreSummary | Promise<StoreSummary> = () => ({ count: 0, recent: [], byAgent: new Map() }),
): typeof withSessionStoreReaderInWorker {
  return async (scope, consume) => {
    const target = resolveUnsuffixedSqliteTargetFromSessionStorePath(scope.storePath);
    const agentId = scope.agentId ?? target.agentId ?? scope.defaultAgentId ?? "main";
    // Synthetic unregistered stores give non-default agents separate physical fixtures.
    const pathname =
      !target.agentId && !target.shared && agentId !== (scope.defaultAgentId ?? "main")
        ? `${target.path.slice(0, -".sqlite".length)}.${agentId}.sqlite`
        : target.path;
    const runRequest: workerReaders.SessionHistoryWorkerRequestRunner = async (
      prepare,
      _bytes,
      receive,
    ) => {
      const request = prepare();
      if (request.kind !== "session-store-summary") {
        throw new Error(`Unexpected formatting fixture read: ${request.kind}`);
      }
      return receive({ kind: "session-store-summary", summary: await readSummary(scope, request) });
    };
    return consume({
      reader: {
        ...workerReaders.createSessionHistoryWorkerReaders(runRequest),
        generation: 0,
        assertCurrent() {},
      },
      database: { agentId, path: pathname, env: scope.env ?? {} },
      logicalAgentId: agentId,
      selectedStore: { path: pathname, physicalPath: pathname },
      assertCurrent() {},
    });
  };
}

/** Observe summary reads while retaining the real worker and source-lifetime owners. */
export function spyOnSessionStoreSummaries() {
  const createReaders = workerReaders.createSessionHistoryWorkerReaders;
  const calls = vi.fn<(read: () => Promise<StoreSummary>) => Promise<StoreSummary>>((read) =>
    read(),
  );
  const observation = vi
    .spyOn(workerReaders, "createSessionHistoryWorkerReaders")
    .mockImplementation((runRequest) => {
      const reader = createReaders(runRequest);
      return {
        ...reader,
        readStoreSummary: (request) => calls(() => reader.readStoreSummary(request)),
      };
    });
  return { calls, restore: () => observation.mockRestore() };
}
