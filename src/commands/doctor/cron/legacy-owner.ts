import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { listAgentEntries } from "../../../agents/agent-scope-config.js";
import { createCronOwnerWriteRefusalError } from "../../../config/io.cron-owner-refusal.js";
import { resolveLegacyAgentRosterOwner } from "../../../config/legacy.roster.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.js";
import { resolveCronJobsStorePathFromConfig } from "../../../cron/store/paths.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { getOpenClawDatabaseMaintenanceScope } from "../../../state/openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { loadLegacyCronRepairState } from "./legacy-repair.js";
import { repairLegacyCronJobOwnersForDoctor, resolveStoredCronJobOwner } from "./store-repair.js";

/** Runs under Doctor's config lock before retiring the source roster's owner marker. */
export async function repairLegacyCronOwnersBeforeConfigWrite(params: {
  snapshot: ConfigFileSnapshot;
  nextConfig: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
}): Promise<string[]> {
  const env = params.env ?? process.env;
  const source = params.snapshot.sourceConfigBeforeMigrations ?? params.snapshot.sourceConfig;
  const legacyOwner = [params.snapshot.sourceConfigBeforeMigrations, params.snapshot.parsed]
    .map(resolveLegacyAgentRosterOwner)
    .find((owner) => owner !== undefined);
  if (!legacyOwner) {
    return [];
  }
  params.assertCurrent?.();
  const storePath = resolveCronJobsStorePathFromConfig(source, env);
  const state = await loadLegacyCronRepairState({
    cfg: params.snapshot.config,
    storePath,
    env,
    readOnly: true,
  });
  params.assertCurrent?.();
  const ownerless =
    state?.rawJobs.some((job) => !resolveStoredCronJobOwner(job)) ||
    state?.ownerRows.some((row) => !resolveStoredCronJobOwner(safeParseJsonRecord(row.job_json)));
  if (!ownerless) {
    return [];
  }
  if (
    !listAgentEntries(params.nextConfig).some(
      (entry) => normalizeAgentId(entry.id) === normalizeAgentId(legacyOwner),
    )
  ) {
    throw createCronOwnerWriteRefusalError(
      `Doctor cannot retire legacy cron owner ${legacyOwner} while its jobs are unassigned. Preserve that agent and rerun "openclaw doctor --fix" first.`,
    );
  }
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  if (!maintenance?.ownsSchemaMaintenance) {
    throw createCronOwnerWriteRefusalError(
      'Cron ownership repair requires Doctor maintenance. Run "openclaw doctor --fix" before retrying the config write.',
    );
  }
  const assertCurrent = () => {
    params.assertCurrent?.();
    maintenance.assertDatabaseAccess(resolveOpenClawStateSqlitePath(env));
  };
  const result = await repairLegacyCronJobOwnersForDoctor(
    { env },
    { assertCurrent, assertOwnedInTransaction: assertCurrent },
    storePath,
    legacyOwner,
  );
  assertCurrent();
  return result.changed > 0
    ? [
        `Preserved ownership for ${result.changed} legacy cron job(s); unassigned jobs retain ${legacyOwner}.`,
        `Saved pre-repair cron backup: ${result.backupPath}`,
      ]
    : [];
}
