import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import type { RepositorySources } from "../repository-sources.js";
import type { PreparedPoolPresenceDemand } from "./prepared-pool-presence.types.js";
import { repositoryWorkerSourceBinding } from "./repository-project-source.js";

export async function readPreparedPoolPresenceDemand(): Promise<
  PreparedPoolPresenceDemand | undefined
> {
  const reply = await executeExistingOpenClawStateRead(
    {},
    { type: "preparedPoolPresence.read", input: undefined },
  );
  return reply?.demand;
}

export async function writePreparedPoolPresenceDemand(
  value: PreparedPoolPresenceDemand | null,
  assertCurrent: () => void,
  sources?: Pick<RepositorySources, "resolve">,
): Promise<PreparedPoolPresenceDemand | undefined> {
  let source: ReturnType<RepositorySources["resolve"]> | undefined;
  try {
    source = value
      ? sources?.resolve(
          value.project.source.url,
          repositoryWorkerSourceBinding(value.project.source).sourceId,
        )
      : undefined;
  } catch {
    throw new Error("Prepared-pool presence demand is invalid");
  }
  if (value && !source) {
    throw new Error("Prepared-pool presence demand is invalid");
  }
  const assertSelected = () => {
    assertCurrent();
    if (value) {
      try {
        source?.assertCurrent();
      } catch {
        throw new Error("Prepared-pool presence demand is invalid");
      }
    }
  };
  const context = captureOpenClawStateWorkerContext();
  return runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "preparedPoolPresence.write",
        input: value,
      }),
    {
      assertCurrent: assertSelected,
      createAdmission: () => ({
        nativeLocations: [context.admission.databasePath],
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          if (request.stage !== "transaction" && request.stage !== "commit") {
            throw new Error("Prepared-pool presence demand requires transaction admission");
          }
          context.admission.assertCurrent();
          assertSelected();
          grant();
        }),
      }),
    },
  );
}
