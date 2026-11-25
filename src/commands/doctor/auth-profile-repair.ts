import { copyConfigResolutionFactsThroughRewrite } from "../../config/resolution-facts.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  collectOpenAICodexAuthProfileStoreIdMap,
  maybeMigrateAuthProfileJsonStoresToSqlite,
  maybeRepairLegacyAuthProfileStores,
  maybeRepairOpenAICodexAuthConfig,
} from "../doctor-auth-flat-profiles.js";
import type { DoctorPrompter } from "../doctor-prompter.js";

/** Complete only verified imports or explicitly requested auth repairs through the same owners. */
export async function repairAuthProfileMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  prompter: Pick<DoctorPrompter, "shouldRepair" | "confirmAutoFix">;
  profileIdMap?: ReadonlyMap<string, string>;
}) {
  const env = params.env ?? process.env;
  const planned =
    params.profileIdMap ?? collectOpenAICodexAuthProfileStoreIdMap({ cfg: params.cfg, env });
  const config = structuredClone(params.cfg);
  const imported = await maybeMigrateAuthProfileJsonStoresToSqlite({
    cfg: config,
    env,
    prompter: { confirmAutoFix: params.prompter.confirmAutoFix },
    openAICodexAuthProfileIdMap: planned,
  });
  const recoveredProfileIds = new Set<string>();
  const recovered =
    imported.detected.length === 0
      ? collectOpenAICodexAuthProfileStoreIdMap({ cfg: config, env, recoveredProfileIds })
      : new Map<string, string>();
  const authorized = new Map(
    [...planned, ...[...recovered].filter(([from]) => recoveredProfileIds.has(from))].filter(
      ([from, to]) =>
        !imported.blockedProfileIds.has(from) &&
        !imported.blockedProfileIds.has(to) &&
        (params.prompter.shouldRepair ||
          (recoveredProfileIds.has(from) && imported.detected.length === 0) ||
          imported.migratedProfileIds.has(from) ||
          imported.migratedProfileIds.has(to)),
    ),
  );
  const aliasesChecked = params.prompter.shouldRepair || authorized.size > 0;
  const aliases = aliasesChecked
    ? await maybeRepairLegacyAuthProfileStores({ cfg: config, env, profileIdMap: authorized })
    : { profileIdMap: authorized, changes: [], warnings: [], findings: [] };
  const remainingTargets = new Set(aliases.findings.map((finding) => finding.target));
  const retainedAliasFindings = aliasesChecked
    ? imported.aliasFindings.filter(
        (finding) => finding.target !== undefined && remainingTargets.has(finding.target),
      )
    : imported.aliasFindings;
  const preciseTargets = new Set(retainedAliasFindings.map((finding) => finding.target));
  const aliasFindings = [
    ...retainedAliasFindings,
    ...aliases.findings.filter(
      (finding) =>
        finding.checkId !== "core/doctor/auth-migration/identity-unresolved" ||
        !preciseTargets.has(finding.target),
    ),
  ];
  const findings = [
    ...new Map(
      [...imported.findings, ...aliasFindings].map(
        (finding) => [`${finding.checkId}\0${finding.target ?? ""}`, finding] as const,
      ),
    ).values(),
  ];
  const repaired = maybeRepairOpenAICodexAuthConfig(config, { profileIdMap: aliases.profileIdMap });
  const configChanged = imported.configChanged || repaired.changes.length > 0;
  if (configChanged) {
    copyConfigResolutionFactsThroughRewrite(params.cfg, repaired.config);
  }
  return {
    config: configChanged ? repaired.config : params.cfg,
    changes: [
      ...repaired.changes,
      ...(imported.configChanged ? ["Auth profile SQLite migration updated auth.profiles."] : []),
    ],
    storeChanges: [...imported.changes, ...aliases.changes],
    warnings: [...imported.warnings, ...aliases.warnings, ...repaired.warnings],
    findings,
    profileIdMap: aliases.profileIdMap,
  };
}

export async function refreshGatewayAuthStateAfterAuthProfileRepair(): Promise<void> {
  const { callGateway } = await import("../../gateway/call.js");
  for (const request of [
    { method: "secrets.reload", params: {} },
    { method: "models.authStatus", params: { refresh: true } },
  ]) {
    try {
      await callGateway({ ...request, timeoutMs: 3000, sharedStateMode: "read-only" });
    } catch {
      // Doctor repair remains best effort when the Gateway is stopped or cannot reload.
    }
  }
}
