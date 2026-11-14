/** The target phase's snapshot-space check, which runs before the update changes anything. */
import path from "node:path";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { resolveStateDir } from "../../config/paths.js";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { assessInitialUpdateSnapshotCapacity } from "../../infra/update-candidate-snapshot.js";
import { resolveNativePackageProjectRoot } from "../../infra/update-native-package-owner.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { defaultRuntime } from "../../runtime.js";
import type { UpdateCommandOptions } from "./shared.js";
import { readUpdateCandidateSource } from "./update-command-managed-context.js";
import {
  assessSnapshotCapacityOfferingCleanup,
  canPromptForSpaceCleanup,
} from "./update-snapshot-space-cleanup.js";

type PackageInstallTarget = Parameters<typeof resolveNativePackageProjectRoot>[0];

/** Returns the refused package step; Git staging keeps its own later refusal. */
export async function checkUpdateTargetSnapshotSpace(params: {
  opts: UpdateCommandOptions;
  updateInstallKind: string;
  packageAlreadyCurrent: boolean;
  sourceReadable: boolean;
  legacyConfigPlan: Parameters<typeof readUpdateCandidateSource>[1];
  root: string;
  packageInstallTarget?: PackageInstallTarget | null;
  packageInstallEnv?: NodeJS.ProcessEnv;
  recordPreflightStep: (result: UpdateStepResult) => void;
  warn: (message: string) => void;
}): Promise<UpdateStepResult | undefined> {
  const { opts } = params;
  const env = opts.run?.env ?? process.env;
  const offer = (backupDirectory: string) =>
    assessSnapshotCapacityOfferingCleanup(
      async () =>
        assessInitialUpdateSnapshotCapacity({
          config: (await readUpdateCandidateSource(env, params.legacyConfigPlan)).config,
          stateDir: resolveStateDir(env),
          env,
          backupDirectory,
        }),
      {
        json: opts.json,
        yes: opts.yes,
        env: opts.run?.env,
        print: (line) => defaultRuntime.log(theme.warn(line)),
      },
    );
  if (opts.dryRun || !params.sourceReadable) {
    return undefined;
  }
  // No-op updates need no candidate snapshot; package-space warnings remain advisory.
  if (params.updateInstallKind === "package" && !params.packageAlreadyCurrent) {
    const target = params.packageInstallTarget;
    const backupProject =
      target && resolveNativePackageProjectRoot(target, params.packageInstallEnv ?? env);
    const snapshot = await offer(
      backupProject
        ? path.dirname(resolvePathViaExistingAncestorSync(backupProject))
        : (target?.globalRoot ?? path.dirname(params.root)),
    );
    opts.run?.executorFence?.assertCurrent();
    params.recordPreflightStep(snapshot);
    if (snapshot.exitCode !== 0) {
      return snapshot;
    }
    for (const warning of snapshot.warnings ?? []) {
      params.warn(warning);
    }
  }
  // Git staging refuses a shortfall mid-update; offer cleanup while nothing has changed.
  // That later check still decides, so a declined or insufficient cleanup changes nothing.
  if (params.updateInstallKind === "git" && canPromptForSpaceCleanup(opts)) {
    await offer(path.join(params.root, ".artifacts"));
    opts.run?.executorFence?.assertCurrent();
  }
  return undefined;
}
