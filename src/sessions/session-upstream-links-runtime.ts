import { assertSessionEntryCurrentAdmission } from "../config/sessions/session-entry-current-admission.js";
import type { SessionEntryCurrentCheck } from "../config/sessions/session-entry-current.types.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  executeOpenClawStateWorker,
  runOpenClawStateWorkerOperation,
} from "../state/openclaw-state-worker-store.js";
import type { SessionUpstreamLink } from "./session-upstream-links.kernel.js";
import type { SessionUpstreamSettlement } from "./session-upstream-links.worker-contract.js";

export function isSessionUpstreamLinkCurrent(
  expected: SessionUpstreamLink,
  options: OpenClawStateDatabaseOptions,
): Promise<boolean> {
  return executeOpenClawStateWorker(captureOpenClawStateWorkerContext(options), {
    type: "sessionUpstream.current",
    input: expected,
  });
}

export function settleSessionUpstreamLink(
  expected: SessionUpstreamLink,
  settlement: SessionUpstreamSettlement,
  options: OpenClawStateDatabaseOptions & {
    assertCurrent: () => void;
    sessionEntryCurrent?: SessionEntryCurrentCheck;
  },
): Promise<boolean> {
  const context = captureOpenClawStateWorkerContext(options);
  const { assertCurrent, sessionEntryCurrent } = options;
  const input = structuredClone({
    expected,
    settlement,
    sessionEntryCurrentSource: sessionEntryCurrent?.source,
  });
  return runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "sessionUpstream.settle", input }),
    {
      assertCurrent,
      createAdmission: () => ({
        nativeLocations: [context.admission.databasePath],
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          if (request.stage !== "transaction" && request.stage !== "commit") {
            throw new Error("Upstream settlement requires transaction admission");
          }
          context.admission.assertCurrent();
          assertCurrent();
          assertSessionEntryCurrentAdmission(request, sessionEntryCurrent);
          grant();
        }),
      }),
    },
  );
}
