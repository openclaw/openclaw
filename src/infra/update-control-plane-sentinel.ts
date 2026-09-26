import fs from "node:fs/promises";
import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import {
  markUpdateRestartSentinelFailure,
  writeRestartSentinel,
  type RestartSentinelPayload,
} from "./restart-sentinel.js";
import {
  resolveUpdateRestartNoticeMeta,
  shouldPublishUpdateRestartNotice,
} from "./update-restart-notice.js";
import {
  buildUpdateRestartSentinelPayload,
  type ForegroundUpdateOrigin,
  type UpdateRestartSentinelMeta,
} from "./update-restart-sentinel-payload.js";
import { getUpdateRun } from "./update-run-ledger.js";
import type { UpdateRunResult } from "./update-runner-types.js";

export const CONTROL_PLANE_UPDATE_SENTINEL_META_ENV = "OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META";
// Internal helper/orchestrator correlation; never persisted as an operator setting.
export const UPDATE_RUN_ID_ENV = "OPENCLAW_UPDATE_RUN_ID";
export const CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON = "managed-service-handoff-started";
const CONTROL_PLANE_UPDATE_RESTART_HEALTH_PENDING_REASON = "restart-health-pending";

// The detached helper must retain an explicit unsafe verdict without relying on
// a notification that another process may consume. Ordinary CLI failures stay 1.
export const MANAGED_SERVICE_UPDATE_UNSAFE_EXIT_CODE = 79;

export function resolveManagedServiceUpdateFailureExitCode(result: UpdateRunResult): number {
  return process.env.OPENCLAW_UPDATE_RUN_HANDOFF === "1" &&
    result.recovery?.serviceRestartSafe === false
    ? MANAGED_SERVICE_UPDATE_UNSAFE_EXIT_CODE
    : 1;
}

const CONTROL_PLANE_UPDATE_PENDING_REASONS = new Set<string>([
  CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON,
  CONTROL_PLANE_UPDATE_RESTART_HEALTH_PENDING_REASON,
]);

export type ControlPlaneUpdateSentinelMetaFile = {
  version: 1;
  meta: UpdateRestartSentinelMeta & { triageContextPath?: string };
};

export function buildControlPlaneUpdateRestartHealthPendingResult(
  result: UpdateRunResult,
): UpdateRunResult {
  return {
    ...(result.runId ? { runId: result.runId } : {}),
    status: "skipped",
    mode: result.mode,
    ...(result.root ? { root: result.root } : {}),
    reason: CONTROL_PLANE_UPDATE_RESTART_HEALTH_PENDING_REASON,
    ...(result.before ? { before: result.before } : {}),
    ...(result.after ? { after: result.after } : {}),
    steps: result.steps,
    durationMs: result.durationMs,
  };
}

export function isPendingControlPlaneUpdateRestartSentinel(
  payload: RestartSentinelPayload,
): boolean {
  const reason = payload.stats?.reason;
  return (
    payload.kind === "update" &&
    payload.status === "skipped" &&
    typeof reason === "string" &&
    CONTROL_PLANE_UPDATE_PENDING_REASONS.has(reason)
  );
}

function normalizeMeta(value: unknown): ControlPlaneUpdateSentinelMetaFile["meta"] | null {
  if (!isRecord(value)) {
    return null;
  }
  const sessionKey = readNonBlankString(value.sessionKey);
  const runId = readNonBlankString(value.runId);
  const threadId = readNonBlankString(value.threadId);
  const handoffId = readNonBlankString(value.handoffId);
  const root = readNonBlankString(value.root);
  const target = readNonBlankString(value.target);
  const triageContextPath = readNonBlankString(value.triageContextPath);
  let foregroundOrigin: ForegroundUpdateOrigin | undefined;
  if (value.foregroundOrigin !== undefined) {
    const origin = value.foregroundOrigin;
    if (!isRecord(origin)) {
      return null;
    }
    const owner = readNonBlankString(origin.owner);
    const pid = asPositiveSafeInteger(origin.pid);
    const host = readNonBlankString(origin.host);
    const port = asPositiveSafeInteger(origin.port);
    const stateDatabasePath = readNonBlankString(origin.stateDatabasePath);
    const configPath = readNonBlankString(origin.configPath);
    if (
      !owner ||
      !pid ||
      !host ||
      !port ||
      port > 65535 ||
      typeof origin.startedAt !== "number" ||
      !Number.isSafeInteger(origin.startedAt) ||
      origin.startedAt < 0 ||
      !stateDatabasePath ||
      !configPath
    ) {
      return null;
    }
    foregroundOrigin = {
      owner,
      pid,
      host,
      startedAt: origin.startedAt,
      port,
      stateDatabasePath,
      configPath,
    };
  }
  const delivery = isRecord(value.deliveryContext) ? value.deliveryContext : undefined;
  const channel = readNonBlankString(delivery?.channel);
  const to = readNonBlankString(delivery?.to);
  const accountId = readNonBlankString(delivery?.accountId);
  const deliveryContext =
    channel || to || accountId
      ? {
          ...(channel ? { channel } : {}),
          ...(to ? { to } : {}),
          ...(accountId ? { accountId } : {}),
        }
      : undefined;
  return {
    ...(runId ? { runId } : {}),
    ...(foregroundOrigin ? { foregroundOrigin } : {}),
    ...(value.completionOwner === "gateway-restart"
      ? { completionOwner: "gateway-restart" as const }
      : {}),
    ...(typeof value.serviceStoppedAtMs === "number" &&
    Number.isSafeInteger(value.serviceStoppedAtMs) &&
    value.serviceStoppedAtMs >= 0
      ? { serviceStoppedAtMs: value.serviceStoppedAtMs }
      : {}),
    ...(root ? { root } : {}),
    ...(target ? { target } : {}),
    ...(triageContextPath ? { triageContextPath } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(deliveryContext ? { deliveryContext } : {}),
    ...(threadId ? { threadId } : {}),
    ...(handoffId ? { handoffId } : {}),
    note: typeof value.note === "string" ? value.note : null,
    continuationMessage:
      typeof value.continuationMessage === "string" ? value.continuationMessage : null,
  };
}

export async function readControlPlaneUpdateSentinelMeta(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ControlPlaneUpdateSentinelMetaFile["meta"] | null> {
  const filePath = env[CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]?.trim();
  if (!filePath) {
    return null;
  }
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1) {
      return null;
    }
    return normalizeMeta(parsed.meta);
  } catch {
    return null;
  }
}

export async function writeControlPlaneUpdateRestartSentinel(
  params: { result: UpdateRunResult; meta: UpdateRestartSentinelMeta },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const runId = params.meta.runId ?? params.result.runId;
  const run = runId ? getUpdateRun(runId, { env }) : undefined;
  const meta = resolveUpdateRestartNoticeMeta(run, params.meta);
  if (!shouldPublishUpdateRestartNotice(run, meta)) {
    return;
  }
  const payload = buildUpdateRestartSentinelPayload({ result: params.result, meta });
  if (
    meta.completionOwner === "gateway-restart" &&
    !isPendingControlPlaneUpdateRestartSentinel(payload) &&
    payload.stats
  ) {
    delete payload.stats.handoffId;
  }
  await writeRestartSentinel(payload, env);
}

export async function markControlPlaneUpdateRestartSentinelFailure(
  reason: string,
  meta?: UpdateRestartSentinelMeta,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinelPayload | null> {
  if (meta?.runId && !shouldPublishUpdateRestartNotice(getUpdateRun(meta.runId, { env }), meta)) {
    return null;
  }
  return (await markUpdateRestartSentinelFailure(reason, env, meta))?.payload ?? null;
}
