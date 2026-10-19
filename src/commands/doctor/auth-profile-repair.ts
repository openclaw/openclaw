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
  const aliases =
    params.prompter.shouldRepair || authorized.size > 0
      ? await maybeRepairLegacyAuthProfileStores({ cfg: config, env, profileIdMap: authorized })
      : { profileIdMap: authorized, changes: [], warnings: [] };
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
      await callGateway({ ...request, timeoutMs: 3000 });
    } catch {
      // Doctor repair remains best effort when the Gateway is stopped or cannot reload.
    }
  }
}
