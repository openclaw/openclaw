import {
  AgentSharedStoreOwnerError,
  assertAgentSessionStoreDeletionSafe,
  readAgentDeleteDatabaseRegistry,
  resolveSurvivingDatabaseFilePaths,
} from "../agents/agent-delete-databases.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  OpenClawAgentDatabaseOwnerInspection,
  OpenClawRegisteredAgentDatabase,
} from "../state/openclaw-agent-db-contract.js";
import type { ClawInventory } from "./inventory-read.kernel.js";
import type { AttachedCronJob } from "./lifecycle-delete-support.js";
import type { ClawRemovePlanOptions } from "./lifecycle-remove-contract.js";
import { readClawStatus } from "./lifecycle-status.js";

export type ClawRemovePlanReadFacts = {
  inventory: ClawInventory;
  registeredAgentDatabases: readonly OpenClawRegisteredAgentDatabase[];
  inspectSessionStoreOwner: (path: string) => OpenClawAgentDatabaseOwnerInspection;
  readAttachedCronJobs: (agentId: string) => Promise<AttachedCronJob[]>;
};

export async function readClawRemovePlanStatus(
  target: string,
  options: ClawRemovePlanOptions,
  readFacts?: ClawRemovePlanReadFacts,
) {
  const packageDeps = readFacts
    ? {
        ...options.packageDeps,
        readPackageRefs: () => [...readFacts.inventory.packages],
        readInstallRecords: () => [...readFacts.inventory.installs],
      }
    : options.packageDeps;
  const status = await readClawStatus(target, {
    ...options,
    ...(readFacts ? { inventory: readFacts.inventory, readOnly: true } : {}),
    ...(packageDeps ? { packageDeps } : {}),
  });
  const records = options.exactAgentId
    ? status.records.filter((candidate) => candidate.install.agentId === target)
    : status.records;
  return { records, packageDeps };
}

export function inspectClawRemoveSessionOwnership(
  config: OpenClawConfig,
  agentId: string,
  options: ClawRemovePlanOptions,
  readFacts?: ClawRemovePlanReadFacts,
): { sharedSessionStoreOwnerMessage?: string; survivingDatabaseFilePaths: string[] } {
  let sharedSessionStoreOwnerMessage: string | undefined;
  try {
    assertAgentSessionStoreDeletionSafe(
      config,
      agentId,
      options,
      readFacts
        ? {
            registeredDatabases: readFacts.registeredAgentDatabases,
            inspectOwner: readFacts.inspectSessionStoreOwner,
          }
        : undefined,
    );
  } catch (error) {
    if (!(error instanceof AgentSharedStoreOwnerError)) {
      throw error;
    }
    sharedSessionStoreOwnerMessage = error.message;
  }
  const registeredDatabases =
    readFacts?.registeredAgentDatabases ?? readAgentDeleteDatabaseRegistry(options);
  return {
    ...(sharedSessionStoreOwnerMessage ? { sharedSessionStoreOwnerMessage } : {}),
    survivingDatabaseFilePaths: resolveSurvivingDatabaseFilePaths(
      registeredDatabases,
      agentId,
      options.env,
    ),
  };
}
