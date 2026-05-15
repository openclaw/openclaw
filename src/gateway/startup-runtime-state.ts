import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type GatewayStartupChannelResult = {
  id: string;
  status: "started" | "failed" | "timed_out" | "skipped";
  durationMs?: number;
  error?: string;
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

function sanitizeRuntimeState(state: GatewayStartupRuntimeState): GatewayStartupRuntimeState {
  const sanitizeText = (value: string): string => value.slice(0, 500);
  return {
    ...state,
    channelResults: state.channelResults.map((result) => ({
      id: sanitizeText(result.id),
      status: result.status,
      ...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
      ...(result.error ? { error: sanitizeText(result.error) } : {}),
    })),
    warnings: state.warnings.map(sanitizeText).slice(0, 50),
    errors: state.errors.map(sanitizeText).slice(0, 50),
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
