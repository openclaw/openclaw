/** Map installed managed Gateway services to profile-scoped inspection bindings. */
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { resolveGatewayLaunchAgentLabel } from "./constants.js";
import { listManagedOpenClawGatewayServices, type ExtraGatewayService } from "./inspect.js";
import { decodeLaunchdPlistMetadata } from "./launchd-plist.js";
import type { LoadedLaunchAgentState } from "./launchd-runtime.js";
import type { GatewayServiceEnv, SystemdServiceReadTarget } from "./service-types.js";
import { resolveSystemdTemplateInstanceName } from "./systemd-scope.js";
import { parseSystemdInlineEnvironment } from "./systemd-unit.js";

export type ManagedGatewayBinding = {
  readonly profile: string;
  readonly env: GatewayServiceEnv;
  readonly scope?: "user" | "system";
  readonly systemdReadTarget?: SystemdServiceReadTarget;
  readonly windowsStartupEntry?: string;
  readonly launchAgentPlistPath?: string;
};

/** Inspect the exact discovered owner; Startup definitions must never borrow Task state. */
export async function readManagedGatewayBindingState(
  binding: ManagedGatewayBinding,
  options: { timeoutMs?: number } = {},
): Promise<LoadedLaunchAgentState> {
  if (process.platform === "darwin") {
    const { readLoadedLaunchAgentState } = await import("./launchd-runtime.js");
    return readLoadedLaunchAgentState(binding.env, {
      ...options,
      plistPath: binding.launchAgentPlistPath,
    });
  }
  const { readGatewayServiceState, resolveGatewayService } = await import("./service.js");
  let timeoutMs = options.timeoutMs;
  if (binding.windowsStartupEntry) {
    const { WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS } =
      await import("../infra/windows-powershell-spawn.js");
    timeoutMs = Math.min(
      timeoutMs ?? WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS,
      WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS,
    );
  }
  return readGatewayServiceState(resolveGatewayService(), {
    env: binding.env,
    requireEffective: true,
    requireLoadedCommand: true,
    ...(binding.systemdReadTarget ? { systemdReadTarget: binding.systemdReadTarget } : {}),
    ...(binding.windowsStartupEntry ? { windowsStartupEntry: binding.windowsStartupEntry } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

function bindingSelectorKey(binding: ManagedGatewayBinding): string {
  return [
    binding.profile,
    binding.scope ?? binding.systemdReadTarget?.scope ?? "",
    binding.systemdReadTarget?.unitPath ?? "",
    binding.launchAgentPlistPath ?? "",
    binding.windowsStartupEntry
      ? path.win32.normalize(binding.windowsStartupEntry).toLowerCase()
      : "",
    binding.env.OPENCLAW_SYSTEMD_UNIT ?? "",
    binding.env.OPENCLAW_LAUNCHD_LABEL ?? "",
    binding.env.OPENCLAW_WINDOWS_TASK_NAME ?? "",
  ].join("\0");
}

function normalizeDiscoveredProfile(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || normalizeLowercaseStringOrEmpty(trimmed) === "default") {
    return "default";
  }
  return trimmed;
}

function hostBindingEnv(
  env: Record<string, string | undefined>,
  extras: GatewayServiceEnv,
): GatewayServiceEnv {
  const host: GatewayServiceEnv = {
    ...(env.HOME !== undefined ? { HOME: env.HOME } : {}),
    ...(env.USERPROFILE !== undefined ? { USERPROFILE: env.USERPROFILE } : {}),
  };
  for (const key of [
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
    "USER",
    "LOGNAME",
    "SUDO_USER",
  ]) {
    if (Object.hasOwn(env, key)) {
      host[key] = env[key];
    }
  }
  return { ...host, ...extras };
}

function profileEnvFields(profile: string): GatewayServiceEnv {
  return profile === "default" ? {} : { OPENCLAW_PROFILE: profile };
}

function inferProfileFromSystemdUnitName(label: string): string | undefined {
  const name = label.endsWith(".service") ? label.slice(0, -".service".length) : label;
  if (name === "openclaw-gateway") {
    return "default";
  }
  const prefix = "openclaw-gateway-";
  if (name.startsWith(prefix) && name.length > prefix.length) {
    return name.slice(prefix.length);
  }
  return undefined;
}

function inferProfileFromLaunchdLabel(label: string): string | undefined {
  if (label === resolveGatewayLaunchAgentLabel()) {
    return "default";
  }
  const prefix = "ai.openclaw.";
  if (label.startsWith(prefix)) {
    const rest = label.slice(prefix.length);
    if (rest && rest !== "node") {
      return rest;
    }
  }
  return undefined;
}

function detailPath(prefix: string, detail: string): string | undefined {
  if (!detail.startsWith(prefix)) {
    return undefined;
  }
  return detail.slice(prefix.length).trim();
}

async function readServiceFile(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

async function bindingFromSystemdService(
  svc: ExtraGatewayService,
  env: Record<string, string | undefined>,
): Promise<ManagedGatewayBinding> {
  const unitPath = detailPath("unit:", svc.detail);
  let envProfile: string | undefined;
  if (unitPath) {
    const bytes = await readServiceFile(unitPath);
    if (bytes) {
      envProfile =
        parseSystemdInlineEnvironment(bytes.toString("utf8")).OPENCLAW_PROFILE?.trim() || undefined;
    }
  }
  const profile = normalizeDiscoveredProfile(
    envProfile ?? inferProfileFromSystemdUnitName(svc.label) ?? "default",
  );
  const unitName = resolveSystemdTemplateInstanceName(svc.label, {
    ...profileEnvFields(profile),
    OPENCLAW_SYSTEMD_UNIT: svc.label,
  });
  const systemdReadTarget = unitPath ? { scope: svc.scope, unitName, unitPath } : undefined;
  return {
    profile,
    scope: svc.scope,
    ...(systemdReadTarget ? { systemdReadTarget } : {}),
    env: hostBindingEnv(env, {
      ...profileEnvFields(profile),
      OPENCLAW_SYSTEMD_UNIT: unitName,
    }),
  };
}

async function bindingFromLaunchdService(
  svc: ExtraGatewayService,
  env: Record<string, string | undefined>,
): Promise<ManagedGatewayBinding> {
  const plistPath = detailPath("plist:", svc.detail);
  let envProfile: string | undefined;
  if (plistPath) {
    const bytes = await readServiceFile(plistPath);
    if (bytes) {
      const plist = await decodeLaunchdPlistMetadata(bytes).catch((error: unknown) => {
        if (hasCommandProcessCleanupError(error)) {
          throw error;
        }
        return undefined;
      });
      const vars = plist?.EnvironmentVariables;
      if (isRecord(vars)) {
        const profileValue = readStringField(vars, "OPENCLAW_PROFILE");
        if (profileValue?.trim()) {
          envProfile = profileValue.trim();
        }
      }
    }
  }
  const inferred = inferProfileFromLaunchdLabel(svc.label);
  const profile = normalizeDiscoveredProfile(envProfile ?? inferred ?? "default");
  return {
    profile,
    scope: svc.scope,
    ...(plistPath ? { launchAgentPlistPath: plistPath } : {}),
    env: hostBindingEnv(env, {
      ...profileEnvFields(profile),
      OPENCLAW_LAUNCHD_LABEL: svc.label,
    }),
  };
}

function bindingFromWindowsTask(
  name: string,
  profile: string,
  env: Record<string, string | undefined>,
): ManagedGatewayBinding {
  return {
    profile,
    scope: "system",
    env: hostBindingEnv(env, {
      ...profileEnvFields(profile),
      OPENCLAW_WINDOWS_TASK_NAME: name.replace(/^\\+/, "").trim() || name,
    }),
  };
}

/**
 * Enumerate installed managed Gateway selectors for runtime mutation checks.
 */
export async function discoverManagedGatewayBindings(
  env: Record<string, string | undefined>,
): Promise<ManagedGatewayBinding[]> {
  const results: ManagedGatewayBinding[] = [];
  const seen = new Set<string>();
  const push = (binding: ManagedGatewayBinding) => {
    const key = bindingSelectorKey(binding);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    results.push(binding);
  };

  try {
    const { services } = await listManagedOpenClawGatewayServices(env);
    // Discovery warnings cannot establish a live process holding this checkout's dist.
    for (const svc of services) {
      if (svc.platform === "linux") {
        push(await bindingFromSystemdService(svc, env));
        continue;
      }
      if (svc.platform === "darwin") {
        push(await bindingFromLaunchdService(svc, env));
        continue;
      }
      if (svc.windowsProfile === undefined) {
        continue;
      }
      if (svc.windowsStartupEntry !== undefined) {
        push({
          profile: svc.windowsProfile,
          scope: "user",
          windowsStartupEntry: svc.windowsStartupEntry,
          env: hostBindingEnv(env, profileEnvFields(svc.windowsProfile)),
        });
        continue;
      }
      push(bindingFromWindowsTask(svc.label, svc.windowsProfile, env));
    }
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    return results;
  }

  return results;
}
