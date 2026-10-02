import type {
  ClawResourceStatus,
  ClawStatusEntry,
  ClawsStatusResult,
} from "../../packages/gateway-protocol/src/schema/claws.js";
import type { CronJob } from "../cron/types.js";
import { CLAW_CRON_REF_SCHEMA_VERSION, clawCronGatewayJobMatchesRef } from "./cron.js";
import type { ClawStatusRecord } from "./lifecycle-status.js";

const PACKAGE_STATUS_REASONS = {
  missing: "The installed package is missing.",
  modified: "The installed package differs from the Claw record.",
  ambiguous: "The installed package identity is ambiguous.",
  incomplete: "Package installation is incomplete.",
  present: undefined,
} satisfies Record<ClawStatusRecord["packages"][number]["state"], string | undefined>;

const CRON_STATUS_REASONS = {
  failed: "Scheduled job setup failed.",
  pending: "Scheduled job setup is pending.",
  removed: "The scheduled job was removed.",
  complete: undefined,
} satisfies Record<ClawStatusRecord["cronJobs"][number]["status"], string | undefined>;

function packageStatusReason(
  state: ClawStatusRecord["packages"][number]["state"],
): string | undefined {
  return PACKAGE_STATUS_REASONS[state];
}

function cronStatusReason(
  status: ClawStatusRecord["cronJobs"][number]["status"],
): string | undefined {
  return CRON_STATUS_REASONS[status];
}

function liveCronStatus(
  record: ClawStatusRecord,
  cron: ClawStatusRecord["cronJobs"][number],
  liveJobs: readonly CronJob[] | undefined,
): { state: string; reason?: string } {
  if (cron.schemaVersion !== CLAW_CRON_REF_SCHEMA_VERSION) {
    return { state: "unresolved", reason: "The scheduled job record has an unsupported version." };
  }
  if (cron.status !== "complete") {
    return {
      state: cron.status,
      ...(cronStatusReason(cron.status) ? { reason: cronStatusReason(cron.status) } : {}),
    };
  }
  if (!cron.schedulerJobId) {
    return { state: "unresolved", reason: "The scheduled job reference has no scheduler ID." };
  }
  if (!liveJobs) {
    return { state: "unresolved", reason: "Live scheduler state is unavailable." };
  }
  const live = liveJobs.find((job) => job.id === cron.schedulerJobId);
  if (!live) {
    return { state: "missing", reason: "The scheduled job is missing." };
  }
  if (!live.enabled || !clawCronGatewayJobMatchesRef(record.install.agentId, cron, live)) {
    return { state: "modified", reason: "The scheduled job differs from the Claw record." };
  }
  return { state: "complete" };
}

function projectResourceStatus(
  record: ClawStatusRecord,
  liveJobs: readonly CronJob[] | undefined,
): ClawResourceStatus[] {
  const adopted = record.install.agentOrigin === "adopted";
  const agentOrigin: ClawResourceStatus["origin"] = adopted ? "pre-existing" : "claw-introduced";
  return [
    {
      kind: "agent",
      id: record.install.agentId,
      state: record.agentState,
      relationship: "managed",
      origin: agentOrigin,
      independentOwner: adopted,
    },
    ...record.workspaceFiles.map((file) => ({
      kind: "workspace-file" as const,
      id: file.path,
      state: file.state,
      relationship: "managed" as const,
      ...(adopted ? {} : { origin: "claw-introduced" as const, independentOwner: false }),
    })),
    ...record.packages.map((pkg) => ({
      kind: pkg.kind,
      id: `${pkg.ref}@${pkg.version}`,
      state:
        pkg.state === "present" && pkg.extensionCompatibility?.state !== "compatible"
          ? (pkg.extensionCompatibility?.state ?? pkg.state)
          : pkg.state,
      ...(pkg.extensionCompatibility?.state === "drifted"
        ? { reason: "Extension capabilities changed after installation." }
        : pkg.extensionCompatibility?.state === "unavailable"
          ? { reason: "Extension compatibility is unavailable." }
          : packageStatusReason(pkg.state)
            ? { reason: packageStatusReason(pkg.state) }
            : {}),
      relationship: pkg.relationship,
      origin: pkg.origin,
      independentOwner: pkg.independentOwner,
    })),
    ...record.mcpServers.map((server) => ({
      kind: "mcp-server" as const,
      id: server.name,
      state: server.state,
      relationship: server.relationship,
      origin: server.origin,
      independentOwner: server.independentOwner,
    })),
    ...record.cronJobs.map((cron) => ({
      kind: "cron-job" as const,
      id: cron.manifestId,
      ...liveCronStatus(record, cron, liveJobs),
      relationship: "managed" as const,
      origin: "claw-introduced" as const,
      independentOwner: false,
    })),
  ];
}

function projectStatusRecord(
  record: ClawStatusRecord,
  liveJobs: readonly CronJob[] | undefined,
): ClawStatusEntry {
  return {
    agentId: record.install.agentId,
    name: record.install.claw.name,
    version: record.install.claw.version,
    sourceKind: record.install.claw.kind,
    status: record.install.status,
    agentState: record.agentState,
    bootstrapState: record.bootstrapState,
    orphaned: record.orphaned === true,
    addedAtMs: record.install.addedAtMs,
    updatedAtMs: record.install.updatedAtMs,
    resources: projectResourceStatus(record, liveJobs),
  };
}

export function projectClawsStatus(
  records: readonly ClawStatusRecord[],
  liveJobs?: readonly CronJob[],
): ClawsStatusResult {
  const projected = records.map((record) => projectStatusRecord(record, liveJobs));
  const resources = projected.flatMap((record) => record.resources);
  const healthyStates = new Set(["present", "unchanged", "complete"]);
  const healthy = projected.filter(
    (record) =>
      record.status === "complete" &&
      record.bootstrapState === "complete" &&
      !record.orphaned &&
      record.resources.every((resource) => healthyStates.has(resource.state)),
  ).length;
  return {
    schemaVersion: "openclaw.clawsGatewayStatus.v1",
    records: projected,
    summary: {
      claws: projected.length,
      healthy,
      attention: projected.length - healthy,
      managed: resources.filter((resource) => resource.relationship === "managed").length,
      referenced: resources.filter((resource) => resource.relationship === "referenced").length,
    },
  };
}
