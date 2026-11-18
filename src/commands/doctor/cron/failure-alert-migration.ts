import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { tryResolveAmbientOwnerAgentId } from "../../../agents/agent-scope-config.js";
import {
  canDeferRehearsalCronMigration,
  createCronOwnerWriteRefusalError,
} from "../../../config/io.cron-owner-refusal.js";
import { sessionCreatorProfileId } from "../../../config/sessions/session-entry-provenance.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { getOpenClawDatabaseMaintenanceScope } from "../../../state/openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import {
  inspectCronJobsForDoctor,
  repairCronJobsForDoctor,
  resolveStoredCronJobOwner,
} from "./store-repair.js";

/** Drops only retired settings; a change to delivery or alerts needs review. */
export function migrateCronFailureSettings(
  job: Record<string, unknown>,
  cron?: OpenClawConfig["cron"],
  scopedPaths: readonly string[] = [],
): string | undefined {
  const alert = asOptionalRecord(job.failureAlert);
  const delivery = asOptionalRecord(job.delivery);
  const destination = asOptionalRecord(delivery?.failureDestination);
  const customKeys = Object.keys(alert ?? {});
  const bestEffort = delivery?.bestEffort === true;
  const retiredDelivery =
    delivery &&
    (Object.hasOwn(delivery, "failureDestination") || Object.hasOwn(delivery, "bestEffort"));
  const invalidAlert = job.failureAlert !== undefined && typeof job.failureAlert !== "boolean";
  if (!invalidAlert && !retiredDelivery && scopedPaths.length === 0) return undefined;
  const dropped = [
    ...Object.keys(destination ?? {}).map((key) => "delivery.failureDestination." + key),
    ...customKeys.map((key) => "failureAlert." + key),
    ...scopedPaths,
    ...(delivery && Object.hasOwn(delivery, "bestEffort") ? ["delivery.bestEffort"] : []),
  ];
  const policy = cron?.failureAlert;
  const alertsWereOn =
    job.failureAlert !== false && (alert || (policy?.enabled !== false && !bestEffort));
  const changesPolicy = customKeys.some((key) => {
    switch (key) {
      case "after":
        return alert?.after !== (policy?.after ?? 1);
      case "cooldownMs":
        return alert?.cooldownMs !== (policy?.cooldownMs ?? 3_600_000);
      case "includeSkipped":
        return alert?.includeSkipped !== (policy?.includeSkipped ?? false);
      default:
        return true;
    }
  });
  const needsReview =
    bestEffort ||
    (invalidAlert && !alert) ||
    (alertsWereOn &&
      (changesPolicy || Object.keys(destination ?? {}).length > 0 || scopedPaths.length > 0));
  if (invalidAlert) job.failureAlert = Boolean(alert);
  else if (bestEffort && job.failureAlert === undefined) job.failureAlert = false;
  if (delivery) {
    delete delivery.failureDestination;
    delete delivery.bestEffort;
  }
  if (needsReview) job.enabled = false;
  const label = JSON.stringify(job.name ?? job.id ?? "unnamed automation");
  const change = dropped.length
    ? "removed " + dropped.join(", ") + "."
    : "converted failure alerts to On/Off.";
  return (
    "Automation " +
    label +
    (job.id ? " (" + job.id + "): " : ": ") +
    change +
    (needsReview
      ? " Paused because its old notification or delivery behavior cannot be kept. Review delivery and failure alerts before re-enabling."
      : "")
  );
}

/** Scoped routes must be dealt with while the authored config still identifies their jobs. */
export async function repairScopedCronFailureAlertsBeforeConfigWrite(params: {
  snapshot: ConfigFileSnapshot;
  nextConfig: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
}): Promise<string[]> {
  const source = params.snapshot.sourceConfigBeforeMigrations ?? params.snapshot.sourceConfig;
  const cron = asOptionalRecord(source.cron);
  const scopedPaths = (scope: "agents" | "creators") =>
    Object.entries(asOptionalRecord(cron?.[scope]) ?? {}).flatMap(([key, entry]) => {
      const route = asOptionalRecord(entry)?.failureAlert;
      const next = params.nextConfig.cron?.[scope]?.[key];
      return route !== undefined && !Object.hasOwn(next ?? {}, "failureAlert")
        ? [{ key, path: "cron." + scope + "." + key + ".failureAlert" }]
        : [];
    });
  const agents = scopedPaths("agents");
  const creators = scopedPaths("creators");
  if (
    (!agents.length && !creators.length) ||
    (await canDeferRehearsalCronMigration(source, params.snapshot.path, params.env))
  ) {
    return [];
  }
  const scope = { env: params.env };
  const inventory = await inspectCronJobsForDoctor(scope);
  const defaultAgent = tryResolveAmbientOwnerAgentId(params.snapshot.config);
  const notes: string[] = [];
  const changes = inventory.jobs.flatMap((job) => {
    if (!job.definition) return [];
    const definition = structuredClone(job.definition);
    const agent = resolveStoredCronJobOwner(definition) ?? defaultAgent;
    const actor = asOptionalRecord(definition.createdActor);
    const creator =
      actor?.type === "human" || actor?.type === "agent" || actor?.type === "system"
        ? sessionCreatorProfileId({
            ...actor,
            type: actor.type,
            id: typeof actor.id === "string" ? actor.id : undefined,
          })
        : undefined;
    const paths = [
      ...creators.filter(({ key }) => key === creator),
      ...agents.filter(({ key }) => !agent || normalizeAgentId(key) === normalizeAgentId(agent)),
    ].map(({ path }) => path);
    if (!paths.length) return [];
    const message = migrateCronFailureSettings(definition, params.nextConfig.cron, paths);
    if (message) notes.push(message);
    return isDeepStrictEqual(job.definition, definition) ? [] : [{ job, definition }];
  });
  const assertCurrent = () => {
    params.assertCurrent?.();
    const maintenance = getOpenClawDatabaseMaintenanceScope();
    if (!maintenance?.ownsSchemaMaintenance) {
      throw createCronOwnerWriteRefusalError(
        'Run "openclaw doctor --fix" before removing scoped automation failure routes.',
      );
    }
    maintenance.assertDatabaseAccess(resolveOpenClawStateSqlitePath(params.env));
  };
  if (changes.length === 0) return notes;
  const result = await repairCronJobsForDoctor(
    scope,
    { assertCurrent, assertOwnedInTransaction: assertCurrent },
    inventory,
    changes,
  );
  if (result.backupPath) notes.push("Saved pre-repair cron backup: " + result.backupPath);
  return [...notes, ...(result.warnings ?? [])];
}
