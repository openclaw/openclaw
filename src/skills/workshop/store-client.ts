import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-contract.js";
import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import type { OpenClawStateLeaseIdentity } from "../../state/openclaw-state-lease-store.js";
import { runWithOpenClawStateLeasesWorker } from "../../state/openclaw-state-lease-worker-storage.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { resolveSkillWorkshopStateDir } from "./proposal-generation.js";
import { databaseOptions, type SkillWorkshopStoreOptions } from "./store-sqlite-schema.js";
import type { SkillWorkshopExecutionOperations } from "./store.worker-contract.js";

export function captureSkillWorkshopStoreOptions<T extends SkillWorkshopStoreOptions>(options: T) {
  const env = cloneEnvWithPlatformSemantics(options.env ?? process.env);
  const stateDir = resolveSkillWorkshopStateDir({ ...options, env });
  const execution = options.execution ?? {
    context: captureOpenClawStateWorkerContext(databaseOptions({ env, stateDir })),
    leases: [],
  };
  return { ...options, stateDir, env, execution };
}

export function executeSkillWorkshopOperation<Key extends keyof SkillWorkshopExecutionOperations>(
  type: Key,
  value: SkillWorkshopExecutionOperations[Key]["input"]["value"],
  options: SkillWorkshopStoreOptions = {},
): Promise<SkillWorkshopExecutionOperations[Key]["output"]> {
  const captured = structuredClone(value);
  const store = captureSkillWorkshopStoreOptions(options);
  const { context, leases } = store.execution;
  const execute = async (
    scope: Pick<SqliteWorkerStore<SkillWorkshopExecutionOperations>, "execute">,
    leaseIdentities?: readonly OpenClawStateLeaseIdentity[],
  ) => {
    if (type !== "workshop.schema.ensure" && type !== "workshop.experience.record") {
      await scope.execute({
        type: "workshop.schema.ensure",
        input: { value: undefined, agentId: store.agentId, leaseIdentities },
      });
    }
    return scope.execute({
      type,
      input: { value: captured, agentId: store.agentId, leaseIdentities },
    });
  };
  if (leases.length > 0) {
    return runWithOpenClawStateLeasesWorker(leases, context, execute);
  }
  const assertCurrent = () => {
    context.admission.assertCurrent();
    context.maintenanceScope?.assertAdmission();
  };
  return runOpenClawStateWorkerOperation(context, execute, {
    assertCurrent,
    createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
      context.admission.databasePath,
    ]),
  });
}

export function ensureSkillWorkshopStore(options: SkillWorkshopStoreOptions = {}) {
  return executeSkillWorkshopOperation("workshop.schema.ensure", undefined, options);
}

export function readStoredProposal(proposalId: string, options: SkillWorkshopStoreOptions = {}) {
  return executeSkillWorkshopOperation("workshop.proposal.read", proposalId, options);
}

export function purgeRejectedStoredProposal(
  proposalId: string,
  options: SkillWorkshopStoreOptions = {},
) {
  return executeSkillWorkshopOperation("workshop.proposal.purge", proposalId, options);
}
