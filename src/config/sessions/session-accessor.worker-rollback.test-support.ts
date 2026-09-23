import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";

/** Refuse COMMIT only after the real worker has prepared the selected row's publication. */
export function refuseSessionEntryWorkerCommit(params: {
  sessionKey: string;
  message: string;
  inspect: (publication: Record<string, unknown>) => void;
}) {
  const admit = workerAdmission.createSqliteWorkerOperationAdmission;
  const refused = vi.fn(params.inspect);
  const interception = vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((callback, attachment) =>
      admit((request, grant) => {
        const publication = isRecord(request.facts) ? request.facts.publication : undefined;
        if (
          request.stage === "commit" &&
          isRecord(publication) &&
          publication.kind === "session-entry-replacements" &&
          Array.isArray(publication.changedKeys) &&
          publication.changedKeys.includes(params.sessionKey)
        ) {
          refused(publication);
          throw new Error(params.message);
        }
        callback(request, grant);
      }, attachment),
    );
  return { refused, restore: () => interception.mockRestore() };
}
