/**
 * Anonymous skill/tool execution telemetry for ClawHub (success rate, platform).
 * Privacy-safe: no user data or prompt content; only execution metadata.
 * Opt-out: telemetry.enabled: false or telemetry.skills.enabled: false in config.
 */

import type { OpenClawConfig } from "../config/types.openclaw.js";
import { VERSION } from "../version.js";

const DEFAULT_CLAWHUB_TELEMETRY_ENDPOINT = "https://clawhub.com/api/skill-telemetry";

export type SkillTelemetryPayload = {
  skill_id: string;
  version: string;
  success: boolean;
  error_type?: string;
  os: string;
  arch: string;
  openclaw_version: string;
  latency_ms?: number;
};

export function isTelemetryEnabled(config?: OpenClawConfig | null): boolean {
  if (!config?.telemetry) {
    return true;
  }
  return config.telemetry.enabled !== false;
}

export function isSkillTelemetryEnabled(config?: OpenClawConfig | null): boolean {
  if (!isTelemetryEnabled(config)) {
    return false;
  }
  const skills = config?.telemetry?.skills;
  return skills?.enabled !== false;
}

export function getClawHubTelemetryEndpoint(config?: OpenClawConfig | null): string {
  const endpoint = config?.telemetry?.clawhub?.endpoint?.trim();
  return endpoint && endpoint.length > 0 ? endpoint : DEFAULT_CLAWHUB_TELEMETRY_ENDPOINT;
}

export function buildSkillTelemetryPayload(params: {
  skill_id: string;
  version: string;
  success: boolean;
  error_type?: string;
  latency_ms?: number;
}): SkillTelemetryPayload {
  return {
    skill_id: params.skill_id,
    version: params.version,
    success: params.success,
    ...(params.error_type ? { error_type: params.error_type } : {}),
    os: process.platform,
    arch: process.arch,
    openclaw_version: VERSION,
    ...(params.latency_ms != null ? { latency_ms: params.latency_ms } : {}),
  };
}

/**
 * Sends skill execution telemetry to ClawHub. Fire-and-forget; does not throw.
 * Call only when isSkillTelemetryEnabled(config) is true.
 */
export function sendSkillTelemetry(
  config: OpenClawConfig | undefined | null,
  payload: SkillTelemetryPayload,
): void {
  if (!isSkillTelemetryEnabled(config)) {
    return;
  }
  const url = getClawHubTelemetryEndpoint(config);
  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {
    // Fire-and-forget: ignore network errors
  });
}
