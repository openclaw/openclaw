import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  deleteOpenClawStateKvJson,
  readOpenClawStateKvJson,
  writeOpenClawStateKvJson,
  type OpenClawStateJsonValue,
} from "../state/openclaw-state-kv.js";

export const GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND = "gateway-supervisor-restart-handoff";
const GATEWAY_RESTART_HANDOFF_TTL_MS = 60_000;
const GATEWAY_RESTART_HANDOFF_KV_SCOPE = "gateway.restart-handoff";
const GATEWAY_RESTART_HANDOFF_KV_KEY = "current";
const MAX_INTENT_ID_LENGTH = 120;
const MAX_PROCESS_INSTANCE_ID_LENGTH = 120;
const MAX_REASON_LENGTH = 200;

const handoffLog = createSubsystemLogger("restart-handoff");

export type GatewayRestartHandoffRestartKind = "full-process" | "update-process";
export type GatewayRestartHandoffSource =
  | "config-write"
  | "gateway-update"
  | "operator-restart"
  | "plugin-change"
  | "signal"
  | "unknown";
export type GatewayRestartHandoffSupervisorMode = "launchd" | "systemd" | "schtasks" | "external";

export type GatewayRestartHandoff = {
  kind: typeof GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND;
  version: 1;
  intentId: string;
  pid: number;
  processInstanceId?: string;
  createdAt: number;
  expiresAt: number;
  reason?: string;
  source: GatewayRestartHandoffSource;
  restartKind: GatewayRestartHandoffRestartKind;
  supervisorMode: GatewayRestartHandoffSupervisorMode;
};

function formatShortDuration(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms));
  if (clamped < 1000) {
    return `${clamped}ms`;
  }
  const seconds = Math.floor(clamped / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
}

function formatDiagnosticValue(value: string): string {
  let normalized = "";
  let previousWasSpace = true;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || /\s/u.test(char)) {
      if (!previousWasSpace) {
        normalized += " ";
        previousWasSpace = true;
      }
      continue;
    }
    normalized += char;
    previousWasSpace = false;
  }
  return normalized.trimEnd();
}

export function formatGatewayRestartHandoffDiagnostic(
  handoff: GatewayRestartHandoff,
  now = Date.now(),
): string {
  const reason = handoff.reason ? formatDiagnosticValue(handoff.reason) : undefined;
  const detail = [
    `${handoff.restartKind} via ${handoff.supervisorMode}`,
    `source=${handoff.source}`,
    reason ? `reason=${reason}` : undefined,
    `pid=${handoff.pid}`,
    `age=${formatShortDuration(now - handoff.createdAt)}`,
    `expiresIn=${formatShortDuration(handoff.expiresAt - now)}`,
  ].filter((value): value is string => Boolean(value));
  return `Recent restart handoff: ${detail.join("; ")}`;
}

export function clearGatewayRestartHandoffSync(env: NodeJS.ProcessEnv = process.env): void {
  deleteOpenClawStateKvJson(GATEWAY_RESTART_HANDOFF_KV_SCOPE, GATEWAY_RESTART_HANDOFF_KV_KEY, {
    env,
  });
}

function normalizePid(pid: number | undefined): number | null {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function normalizeText(value: unknown, maxLength: number): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, maxLength) : undefined;
}

function normalizeCreatedAt(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : Date.now();
}

function normalizeTtlMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return GATEWAY_RESTART_HANDOFF_TTL_MS;
  }
  return Math.min(Math.floor(value), GATEWAY_RESTART_HANDOFF_TTL_MS);
}

function normalizeSource(
  source: GatewayRestartHandoffSource | undefined,
  reason: string | undefined,
): GatewayRestartHandoffSource {
  if (source) {
    return source;
  }
  if (!reason) {
    return "unknown";
  }
  const normalized = reason.toLowerCase();
  if (normalized === "update.run") {
    return "gateway-update";
  }
  if (normalized === "sigusr1") {
    return "signal";
  }
  if (normalized === "gateway.restart") {
    return "operator-restart";
  }
  if (normalized.includes("plugin")) {
    return "plugin-change";
  }
  if (normalized.includes("config") || normalized.includes("include")) {
    return "config-write";
  }
  return "unknown";
}

function isSource(value: unknown): value is GatewayRestartHandoffSource {
  return (
    value === "config-write" ||
    value === "gateway-update" ||
    value === "operator-restart" ||
    value === "plugin-change" ||
    value === "signal" ||
    value === "unknown"
  );
}

function isRestartKind(value: unknown): value is GatewayRestartHandoffRestartKind {
  return value === "full-process" || value === "update-process";
}

function isSupervisorMode(value: unknown): value is GatewayRestartHandoffSupervisorMode {
  return value === "launchd" || value === "systemd" || value === "schtasks" || value === "external";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseGatewayRestartHandoff(parsed: unknown): GatewayRestartHandoff | null {
  if (!isRecord(parsed)) {
    return null;
  }
  if (
    parsed.kind !== GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND ||
    parsed.version !== 1 ||
    typeof parsed.intentId !== "string" ||
    parsed.intentId.trim().length === 0 ||
    typeof parsed.pid !== "number" ||
    !Number.isSafeInteger(parsed.pid) ||
    parsed.pid <= 0 ||
    typeof parsed.createdAt !== "number" ||
    !Number.isFinite(parsed.createdAt) ||
    typeof parsed.expiresAt !== "number" ||
    !Number.isFinite(parsed.expiresAt) ||
    parsed.expiresAt <= parsed.createdAt ||
    parsed.expiresAt - parsed.createdAt > GATEWAY_RESTART_HANDOFF_TTL_MS ||
    !isSource(parsed.source) ||
    !isRestartKind(parsed.restartKind) ||
    !isSupervisorMode(parsed.supervisorMode)
  ) {
    return null;
  }
  if (parsed.reason !== undefined && typeof parsed.reason !== "string") {
    return null;
  }
  if (parsed.processInstanceId !== undefined && typeof parsed.processInstanceId !== "string") {
    return null;
  }

  const processInstanceId = normalizeText(parsed.processInstanceId, MAX_PROCESS_INSTANCE_ID_LENGTH);
  const reason = normalizeText(parsed.reason, MAX_REASON_LENGTH);
  return {
    kind: GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND,
    version: 1,
    intentId: parsed.intentId.trim().slice(0, MAX_INTENT_ID_LENGTH),
    pid: parsed.pid,
    ...(processInstanceId ? { processInstanceId } : {}),
    createdAt: Math.floor(parsed.createdAt),
    expiresAt: Math.floor(parsed.expiresAt),
    ...(reason ? { reason } : {}),
    source: parsed.source,
    restartKind: parsed.restartKind,
    supervisorMode: parsed.supervisorMode,
  };
}

export function writeGatewayRestartHandoffSync(opts: {
  env?: NodeJS.ProcessEnv;
  pid?: number;
  processInstanceId?: string;
  reason?: string;
  source?: GatewayRestartHandoffSource;
  restartKind: GatewayRestartHandoffRestartKind;
  supervisorMode?: GatewayRestartHandoffSupervisorMode | null;
  ttlMs?: number;
  createdAt?: number;
}): GatewayRestartHandoff | null {
  const pid = normalizePid(opts.pid ?? process.pid);
  if (pid === null || !isRestartKind(opts.restartKind)) {
    return null;
  }
  if (opts.source !== undefined && !isSource(opts.source)) {
    return null;
  }
  const supervisorMode = opts.supervisorMode ?? "external";
  if (!isSupervisorMode(supervisorMode)) {
    return null;
  }

  const env = opts.env ?? process.env;
  const createdAt = normalizeCreatedAt(opts.createdAt);
  const ttlMs = normalizeTtlMs(opts.ttlMs);
  const reason = normalizeText(opts.reason, MAX_REASON_LENGTH);
  const processInstanceId = normalizeText(opts.processInstanceId, MAX_PROCESS_INSTANCE_ID_LENGTH);
  const payload: GatewayRestartHandoff = {
    kind: GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND,
    version: 1,
    intentId: randomUUID(),
    pid,
    ...(processInstanceId ? { processInstanceId } : {}),
    createdAt,
    expiresAt: createdAt + ttlMs,
    ...(reason ? { reason } : {}),
    source: normalizeSource(opts.source, reason),
    restartKind: opts.restartKind,
    supervisorMode,
  };

  try {
    writeOpenClawStateKvJson<OpenClawStateJsonValue>(
      GATEWAY_RESTART_HANDOFF_KV_SCOPE,
      GATEWAY_RESTART_HANDOFF_KV_KEY,
      payload as unknown as OpenClawStateJsonValue,
      { env },
    );
    return payload;
  } catch (err) {
    handoffLog.warn(`failed to write gateway restart handoff: ${String(err)}`);
    return null;
  }
}

export function readGatewayRestartHandoffSync(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): GatewayRestartHandoff | null {
  const raw = readOpenClawStateKvJson(
    GATEWAY_RESTART_HANDOFF_KV_SCOPE,
    GATEWAY_RESTART_HANDOFF_KV_KEY,
    {
      env,
    },
  );
  const payload = parseGatewayRestartHandoff(raw);
  if (!payload || now < payload.createdAt || now > payload.expiresAt) {
    return null;
  }
  return payload;
}

export function consumeGatewayRestartHandoffForExitedProcessSync(opts: {
  env?: NodeJS.ProcessEnv;
  exitedPid?: number;
  processInstanceId?: string;
  now?: number;
}): GatewayRestartHandoff | null {
  const env = opts.env ?? process.env;
  const raw = readOpenClawStateKvJson(
    GATEWAY_RESTART_HANDOFF_KV_SCOPE,
    GATEWAY_RESTART_HANDOFF_KV_KEY,
    { env },
  );
  try {
    clearGatewayRestartHandoffSync(env);
  } catch {
    // best-effort cleanup
  }

  const payload = parseGatewayRestartHandoff(raw);
  const exitedPid = normalizePid(opts.exitedPid);
  if (!payload || exitedPid === null || payload.pid !== exitedPid) {
    return null;
  }

  const expectedProcessInstanceId = normalizeText(
    opts.processInstanceId,
    MAX_PROCESS_INSTANCE_ID_LENGTH,
  );
  if (expectedProcessInstanceId && payload.processInstanceId !== expectedProcessInstanceId) {
    return null;
  }

  const now = opts.now ?? Date.now();
  if (now < payload.createdAt || now > payload.expiresAt) {
    return null;
  }
  return payload;
}
