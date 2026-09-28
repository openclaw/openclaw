import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isValidProfileName, normalizeProfileName } from "../cli/profile-utils.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "../cli/profile.js";
import { mergeProcessEnv, resolveEnvironmentValue } from "../infra/process-env.js";
import { resolveRuntimeScriptPosition } from "./runtime-binary.js";
import type { GatewayServiceCommandConfig, GatewayServiceEnv } from "./service-types.js";

export function resolveWindowsServiceCommandProfile(
  command: Pick<GatewayServiceCommandConfig, "programArguments" | "environment">,
):
  | { kind: "resolved"; profile: string; source: "argv" | "environment" | "default" }
  | { kind: "unavailable" } {
  if (!command.programArguments[0]?.trim()) {
    return { kind: "unavailable" };
  }
  const position = resolveRuntimeScriptPosition(command.programArguments);
  if (typeof position !== "number" && position.kind !== "not-runtime") {
    return { kind: "unavailable" };
  }
  const entryIndex = typeof position === "number" ? position : 0;
  if (!command.programArguments[entryIndex]?.trim()) {
    return { kind: "unavailable" };
  }
  const parsed = parseCliProfileArgs(["node", ...command.programArguments.slice(entryIndex)]);
  const saved = normalizeOptionalString(
    resolveEnvironmentValue(command.environment, "OPENCLAW_PROFILE", "win32"),
  );
  if (!parsed.ok || (saved !== undefined && !isValidProfileName(saved))) {
    return { kind: "unavailable" };
  }
  if (parsed.profile !== null) {
    return {
      kind: "resolved",
      profile: normalizeProfileName(parsed.profile) ?? "default",
      source: "argv",
    };
  }
  return {
    kind: "resolved",
    profile: normalizeProfileName(saved) ?? "default",
    source: saved === undefined ? "default" : "environment",
  };
}

function projectWindowsServiceEnv(
  ...sources: Array<GatewayServiceEnv | undefined>
): GatewayServiceEnv {
  // The effective clone uses canonical keys for CLI projection; captured maps stay untouched.
  return Object.fromEntries(
    Object.entries(mergeProcessEnv(sources, "win32")).map(([key, value]) => [
      key.toUpperCase(),
      value,
    ]),
  );
}

export function mergeGatewayServiceEnv(
  baseEnv: GatewayServiceEnv,
  command: GatewayServiceCommandConfig | null,
): GatewayServiceEnv {
  const windows = process.platform === "win32";
  if (!command || (!command.environment && !windows)) {
    return baseEnv;
  }
  const callerEnv = windows ? projectWindowsServiceEnv(baseEnv) : baseEnv;
  const merged = windows
    ? projectWindowsServiceEnv(baseEnv, command.environment)
    : { ...baseEnv, ...command.environment };
  if (windows) {
    const profile = resolveWindowsServiceCommandProfile(command);
    if (profile.kind === "resolved" && profile.source === "argv") {
      applyCliProfileEnv({ profile: profile.profile, env: merged });
    }
  }
  // Payload environment cannot redirect the caller's supervisor bus or account.
  for (const key of [
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
    "USER",
    "LOGNAME",
    "SUDO_USER",
  ]) {
    if (Object.hasOwn(callerEnv, key)) {
      merged[key] = callerEnv[key];
    } else {
      delete merged[key];
    }
  }
  for (const key of [
    "OPENCLAW_LAUNCHD_LABEL",
    "OPENCLAW_SYSTEMD_UNIT",
    "OPENCLAW_WINDOWS_TASK_NAME",
  ]) {
    // Explicit caller env selects the target service identity; installed command
    // env may come from a different profile or stale service file.
    const value = callerEnv[key]?.trim();
    if (value) {
      merged[key] = value;
    }
  }
  return merged;
}
