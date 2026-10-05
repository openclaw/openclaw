import path from "node:path";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { readJson } from "../../infra/json-files.js";
import { resolveOpenClawPackageRoot } from "../../infra/openclaw-root.js";
import { inspectUpgradeRecipeInstallation } from "../../infra/upgrade-recipes/inventory.js";
import { createUpgradeRecipePlan } from "../../infra/upgrade-recipes/planner.js";
import { defaultRuntime } from "../../runtime.js";

export type UpdateRecipePlanOptions = {
  installation?: string;
  target?: string;
  catalog?: string;
  json?: boolean;
};

export async function updateRecipePlanCommand(opts: UpdateRecipePlanOptions): Promise<void> {
  const root =
    opts.installation ??
    (await resolveOpenClawPackageRoot({ argv1: process.argv[1] })) ??
    (await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url }));
  if (!root) {
    throw new Error("Cannot identify the invoking installation. Supply --installation <path>.");
  }
  let catalog: unknown;
  if (opts.catalog) {
    try {
      catalog = await readJson<unknown>(path.resolve(opts.catalog), { maxBytes: 4 * 1024 * 1024 });
    } catch {
      const blocker = {
        code: "catalog-unreadable",
        message: "Local catalog could not be read as bounded JSON.",
        nextAction: "Supply a readable JSON catalog no larger than 4 MiB with --catalog.",
      };
      if (opts.json) {
        defaultRuntime.writeJson({
          schemaVersion: 1,
          kind: "report-only",
          mutationEnabled: false,
          outcome: "blocked",
          blockers: [blocker],
        });
      } else {
        defaultRuntime.log(`${blocker.code}: ${blocker.message}\nNext: ${blocker.nextAction}`);
      }
      process.exitCode = 1;
      return;
    }
  }
  const inventory = await inspectUpgradeRecipeInstallation(path.resolve(root));
  const plan = createUpgradeRecipePlan({ inventory, targetReleaseId: opts.target, catalog });
  if (opts.json) {
    defaultRuntime.writeJson(plan);
  } else {
    defaultRuntime.log(`Upgrade recipe plan: ${plan.outcome} (report only; mutation disabled)`);
    defaultRuntime.log(`Installation: ${sanitizeTerminalText(plan.inventory.root)}`);
    if (plan.targetReleaseId) {
      defaultRuntime.log(`Target: ${sanitizeTerminalText(plan.targetReleaseId)}`);
    }
    for (const blocker of plan.blockers) {
      defaultRuntime.log(
        sanitizeTerminalText(`${blocker.code}: ${blocker.message}\nNext: ${blocker.nextAction}`),
      );
    }
    for (const gap of plan.verificationGaps) {
      defaultRuntime.log(`Verification gap: ${sanitizeTerminalText(gap)}`);
    }
    defaultRuntime.log(`Plan digest: ${plan.digest}`);
  }
  if (plan.outcome === "blocked") {
    process.exitCode = 1;
  }
}
