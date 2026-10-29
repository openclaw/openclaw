import path from "node:path";
import { isPathInside } from "./path-guards.js";
import { createLegacyStateMigrationStepReceipt } from "./state-migrations.messages.js";
import {
  createBlockedLegacyStateMigrationStepReceipts,
  migrationStepPlan,
} from "./state-migrations.plan.js";
import type {
  LegacyStateMigrationStep,
  LegacyStateMigrationStepReceipt,
  MigrationMessages,
} from "./state-migrations.types.js";

export async function runLegacyStateMigrationSteps(
  steps: readonly LegacyStateMigrationStep[],
  onStepReceipt?: (receipt: LegacyStateMigrationStepReceipt) => void,
  shouldRun?: (step: LegacyStateMigrationStep) => boolean,
  options?: {
    onUnexpectedFailure?: (error: unknown) => void;
    refusedAgentDatabasePaths?: Set<string>;
  },
): Promise<{
  sources: MigrationMessages[];
  sharedSources: MigrationMessages[];
  finalSources: MigrationMessages[];
  sharedNoticeSources: MigrationMessages[];
  finalNoticeSources: MigrationMessages[];
  entries: Array<{ id: string; result: MigrationMessages }>;
  receipts: LegacyStateMigrationStepReceipt[];
  deferredSteps: LegacyStateMigrationStep[];
  haltedBy: LegacyStateMigrationStepReceipt | undefined;
}> {
  const sources: MigrationMessages[] = [];
  const sharedSources: MigrationMessages[] = [];
  const finalSources: MigrationMessages[] = [];
  const sharedNoticeSources: MigrationMessages[] = [];
  const finalNoticeSources: MigrationMessages[] = [];
  const entries: Array<{ id: string; result: MigrationMessages }> = [];
  const receipts: LegacyStateMigrationStepReceipt[] = [];
  const deferredSteps: LegacyStateMigrationStep[] = [];
  let haltedBy: LegacyStateMigrationStepReceipt | undefined;

  // Keep writers serial. Scoped ownership refusals leave independent owners available.
  for (const [index, step] of steps.entries()) {
    const refusedDependencies = [...(options?.refusedAgentDatabasePaths ?? [])].filter(
      (databasePath) =>
        // Post-session plugins depend on canonical session repair, including its database owners.
        step.deferredExecution?.kind === "post-session-plugin" ||
        (step.reversibility !== "not-applicable" &&
          [...step.source, ...step.target].some(
            (endpoint) =>
              endpoint.kind !== "owner" &&
              (path.resolve(endpoint.path) === databasePath ||
                (endpoint.kind === "path" && isPathInside(endpoint.path, databasePath))),
          )),
    );
    if (refusedDependencies.length > 0) {
      const message = `Migration step "${step.id}" was not run because it requires refused agent database(s): ${refusedDependencies.join(", ")}.`;
      const result = { changes: [], warnings: [message] };
      const receipt: LegacyStateMigrationStepReceipt = {
        ...migrationStepPlan(step),
        outcome: "refused",
        ...result,
        refusal: { code: "blocked-by-agent-database-refusal", message },
        refusedAgentDatabasePaths: refusedDependencies,
      };
      entries.push({ id: step.id, result });
      receipts.push(receipt);
      onStepReceipt?.(receipt);
      sources.push(result);
      (step.phase === "shared" ? sharedSources : finalSources).push(result);
      continue;
    }
    if (step.deferredExecution) {
      // This phase depends on later canonical session repair. Keep its authority open
      // until that writer runs; an earlier refusal still closes it through the tail path.
      deferredSteps.push(step);
      continue;
    }
    if (shouldRun && !shouldRun(step) && step.requiredness === "not-required") {
      const receipt: LegacyStateMigrationStepReceipt = {
        ...migrationStepPlan(step),
        outcome: "skipped",
        changes: [],
        warnings: [],
      };
      receipts.push(receipt);
      onStepReceipt?.(receipt);
      continue;
    }
    let result: MigrationMessages;
    let receipt: LegacyStateMigrationStepReceipt | undefined;
    let unexpectedFailure: { error: unknown } | undefined;
    try {
      result = await step.run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { changes: [], warnings: [message] };
      receipt = {
        ...migrationStepPlan(step),
        outcome: "refused",
        ...result,
        refusal: { code: "step-threw", message },
      };
      unexpectedFailure = { error };
    }
    receipt ??= createLegacyStateMigrationStepReceipt(migrationStepPlan(step), result);
    entries.push({ id: step.id, result });
    receipts.push(receipt);
    onStepReceipt?.(receipt);
    if (unexpectedFailure) {
      options?.onUnexpectedFailure?.(unexpectedFailure.error);
    }
    sources.push(result);
    (step.phase === "shared" ? sharedSources : finalSources).push(result);
    if (!unexpectedFailure && step.collectNotices) {
      (step.phase === "shared" ? sharedNoticeSources : finalNoticeSources).push(result);
    }
    if (receipt.outcome === "refused") {
      if (
        step.id === "media-persistence" &&
        result.refusedAgentDatabasePaths?.length &&
        options?.refusedAgentDatabasePaths
      ) {
        for (const databasePath of result.refusedAgentDatabasePaths) {
          options.refusedAgentDatabasePaths.add(path.resolve(databasePath));
        }
        continue;
      }
      haltedBy = receipt;
      receipts.push(
        ...createBlockedLegacyStateMigrationStepReceipts({
          steps: steps.slice(index + 1),
          blocker: receipt,
          onStepReceipt,
        }),
      );
      break;
    }
  }

  return {
    sources,
    sharedSources,
    finalSources,
    sharedNoticeSources,
    finalNoticeSources,
    entries,
    receipts,
    deferredSteps,
    haltedBy,
  };
}
