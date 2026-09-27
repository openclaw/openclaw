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
      ? maybeRepairLegacyAuthProfileStores({ cfg: config, env, profileIdMap: authorized })
      : { profileIdMap: authorized, changes: [], warnings: [] };
  const repaired = maybeRepairOpenAICodexAuthConfig(config, { profileIdMap: aliases.profileIdMap });
  return {
    config: repaired.config,
    changes: [
      ...repaired.changes,
      ...(imported.configChanged ? ["Auth profile SQLite migration updated auth.profiles."] : []),
    ],
    storeChanges: [...imported.changes, ...aliases.changes],
    warnings: [...imported.warnings, ...aliases.warnings, ...repaired.warnings],
    profileIdMap: aliases.profileIdMap,
  };
}
