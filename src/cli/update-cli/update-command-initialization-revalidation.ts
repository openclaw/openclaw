import { resolveConfigPath } from "../../config/paths.js";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { usesCandidateUpdateAdmission, type UpdateCommandOptions } from "./shared.js";
import type { UpdateInitializationAdmission } from "./update-command-initialization-types.js";
import { revalidateUpdateDatabaseContext } from "./update-command-managed-context.js";
import { GatewayServiceUpdateOwnershipError } from "./update-command-service-plan.js";

export async function revalidateUpdateInitializationAdmission(params: {
  initialization?: UpdateInitializationAdmission;
  env: NodeJS.ProcessEnv;
  opts: UpdateCommandOptions;
  installKind?: "git" | "package" | "unknown";
}): Promise<void> {
  const initialized = params.initialization;
  if (!initialized) {
    return;
  }
  if (
    resolvePathViaExistingAncestorSync(resolveOpenClawStateSqlitePath(params.env)) !==
      initialized.databasePath ||
    resolvePathViaExistingAncestorSync(resolveConfigPath(params.env)) !== initialized.configPath
  ) {
    throw new GatewayServiceUpdateOwnershipError(
      "Gateway state or configuration selectors changed during target initialization. Retry from the installation's current owning account.",
      undefined,
      undefined,
      "service-context-changed",
    );
  }
  if (!initialized.target) {
    return;
  }
  const current = await revalidateUpdateDatabaseContext({
    env: params.env,
    readEnv: params.env,
    config: initialized.target.configSnapshot.sourceConfig,
    configSnapshot: initialized.target.configSnapshot,
    ...(initialized.target.updateInstallKind === "package" &&
    usesCandidateUpdateAdmission(params.opts, params.installKind ?? "unknown")
      ? { configValidation: "candidate" as const }
      : {}),
    ...(initialized.target.legacyConfigPlan
      ? { legacyConfigPlan: initialized.target.legacyConfigPlan }
      : {}),
  });
  initialized.target.configSnapshot = current.configSnapshot;
  initialized.target.legacyConfigPlan = current.legacyConfigPlan;
  initialized.target.configReadFailure = undefined;
}
