import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type GatewayStartupChannelResult = {
  id: string;
  status: "started" | "failed" | "timed_out" | "skipped";
  durationMs?: number;
  error?: string;
};

export type GatewayStartupReadiness = {
  httpReady: boolean;
  sidecarsReady: boolean;
  fullyReady: boolean;
  phase: string;
  message: string;
};

export type GatewayStartupRuntimeState = {
  pid: number;
  port?: number;
  safeMode: boolean;
  startupPhase?: string;
  pluginsLoaded: number;
  providersSkipped: boolean;
  channelsSkipped: boolean;
  channelsAttempted: number;
  channelsStarted: number;
  channelsFailed: number;
  channelsTimedOut: number;
  channelResults: GatewayStartupChannelResult[];
  bonjourDisabled?: boolean;
  modelPricingStartupDisabled?: boolean;
  startupDurationMs: number;
  warnings: string[];
  errors: string[];
  updatedAt: string;
};

export const GATEWAY_STARTUP_RUNTIME_STATE_FILENAME = "gateway-startup-runtime.json";

export function resolveGatewayStartupRuntimeStatePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveStateDir(env), GATEWAY_STARTUP_RUNTIME_STATE_FILENAME);
}

export function createGatewayStartupRuntimeState(params: {
  port?: number;
  safeMode: boolean;
  startupPhase?: string;
  pluginsLoaded?: number;
  providersSkipped?: boolean;
  channelsSkipped?: boolean;
  bonjourDisabled?: boolean;
  modelPricingStartupDisabled?: boolean;
  startupStartedAt?: number;
}): GatewayStartupRuntimeState {
  return {
    pid: process.pid,
    port: params.port,
    safeMode: params.safeMode,
    startupPhase: params.startupPhase,
    pluginsLoaded: params.pluginsLoaded ?? 0,
    providersSkipped: params.providersSkipped ?? false,
    channelsSkipped: params.channelsSkipped ?? false,
    channelsAttempted: 0,
    channelsStarted: 0,
    channelsFailed: 0,
    channelsTimedOut: 0,
    channelResults: [],
    bonjourDisabled: params.bonjourDisabled,
    modelPricingStartupDisabled: params.modelPricingStartupDisabled,
    startupDurationMs: params.startupStartedAt ? Date.now() - params.startupStartedAt : 0,
    warnings: [],
    errors: [],
    updatedAt: new Date().toISOString(),
  };
}

const REDACTED = "[REDACTED]";
const MAX_STARTUP_STATE_STRING_LENGTH = 500;

export function redactStartupRuntimeText(value: string): string {
  return value
    .replace(/\b(authorization\s*:\s*bearer)\s+[^\s,;"'}\]]+/gi, `$1 ${REDACTED}`)
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, `Bearer ${REDACTED}`)
    .replace(/\b(token|access_token|refresh_token|api_key|apikey|secret|password|passwd)\s*=\s*[^\s,;"'}\]]+/gi, `$1=${REDACTED}`)
    .replace(/\b(password|pwd)\s*[:=]\s*[^\s,;"'}\]]+/gi, `$1=${REDACTED}`)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, `$1${REDACTED}:${REDACTED}@`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\b(openclaw\.json|OPENCLAW_[A-Z0-9_]*|gateway\.auth|secrets?\.[A-Za-z0-9_.-]+)\b[^\n\r]{0,120}/gi, `$1 ${REDACTED}`);
}

function sanitizeStartupRuntimeText(value: string): string {
  return redactStartupRuntimeText(value).slice(0, MAX_STARTUP_STATE_STRING_LENGTH);
}

export function resolveGatewayStartupReadiness(
  state: GatewayStartupRuntimeState | null,
): GatewayStartupReadiness {
  if (!state) {
    return {
      httpReady: false,
      sidecarsReady: false,
      fullyReady: false,
      phase: "unknown",
      message: "No running gateway runtime state detected.",
    };
  }
  const phase = state.startupPhase ?? "unknown";
  const httpReady = phase === "http-ready" || phase === "sidecars-ready" || phase === "ready";
  const sidecarsReady = phase === "sidecars-ready" || phase === "ready" || state.channelsSkipped;
  const fullyReady = httpReady && sidecarsReady && state.channelsTimedOut === 0 && state.errors.length === 0;
  const problemCount = state.channelsFailed + state.channelsTimedOut + state.errors.length;
  const mode = state.safeMode ? "safe mode" : "normal mode";
  const message = fullyReady
    ? `Gateway ${mode} startup is ready.`
    : phase === "http-ready"
      ? "Gateway HTTP is ready; sidecars/channels are still starting."
      : problemCount > 0
        ? `Gateway startup has ${problemCount} warning/error condition(s).`
        : `Gateway startup phase is ${phase}.`;
  return { httpReady, sidecarsReady, fullyReady, phase, message };
}

function sanitizeRuntimeState(state: GatewayStartupRuntimeState): GatewayStartupRuntimeState {
  return {
    ...state,
    startupPhase: state.startupPhase ? sanitizeStartupRuntimeText(state.startupPhase) : undefined,
    channelResults: state.channelResults.map((result) => ({
      id: sanitizeStartupRuntimeText(result.id),
      status: result.status,
      ...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
      ...(result.error ? { error: sanitizeStartupRuntimeText(result.error) } : {}),
    })),
    warnings: state.warnings.map(sanitizeStartupRuntimeText).slice(0, 50),
    errors: state.errors.map(sanitizeStartupRuntimeText).slice(0, 50),
    updatedAt: new Date().toISOString(),
  };
}

export function writeGatewayStartupRuntimeState(
  state: GatewayStartupRuntimeState,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    const filePath = resolveGatewayStartupRuntimeStatePath(env);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(sanitizeRuntimeState(state), null, 2)}\n`, "utf-8");
  } catch {
    // Best-effort observability only. Startup must not fail because diagnostics could not be persisted.
  }
}

export function readGatewayStartupRuntimeState(
  env: NodeJS.ProcessEnv = process.env,
): GatewayStartupRuntimeState | null {
  try {
    const raw = fs.readFileSync(resolveGatewayStartupRuntimeStatePath(env), "utf-8");
    const parsed = JSON.parse(raw) as Partial<GatewayStartupRuntimeState>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.pid !== "number") {
      return null;
    }
    return {
      pid: parsed.pid,
      port: parsed.port,
      safeMode: parsed.safeMode === true,
      startupPhase: parsed.startupPhase,
      pluginsLoaded: parsed.pluginsLoaded ?? 0,
      providersSkipped: parsed.providersSkipped === true,
      channelsSkipped: parsed.channelsSkipped === true,
      channelsAttempted: parsed.channelsAttempted ?? 0,
      channelsStarted: parsed.channelsStarted ?? 0,
      channelsFailed: parsed.channelsFailed ?? 0,
      channelsTimedOut: parsed.channelsTimedOut ?? 0,
      channelResults: Array.isArray(parsed.channelResults) ? parsed.channelResults : [],
      bonjourDisabled: parsed.bonjourDisabled,
      modelPricingStartupDisabled: parsed.modelPricingStartupDisabled,
      startupDurationMs: parsed.startupDurationMs ?? 0,
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      errors: Array.isArray(parsed.errors) ? parsed.errors : [],
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return null;
  }
}
