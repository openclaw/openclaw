/** Bind discovered native service selectors without granting lifecycle authority. */
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { listManagedOpenClawGatewayServices, type ExtraGatewayService } from "./inspect.js";
import type { LoadedLaunchAgentState } from "./launchd-runtime.js";
import { resolveTaskName } from "./schtasks-layout.js";
import type { GatewayServiceEnv, SystemdServiceReadTarget } from "./service-types.js";
import { resolveSystemdTemplateInstanceName } from "./systemd-scope.js";
import { resolveSystemdServiceName } from "./systemd-service-files.js";

export type ManagedGatewayBinding = {
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
    normalizeDiscoveredProfile(binding.env.OPENCLAW_PROFILE),
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

function bindingFromSystemdService(
  svc: ExtraGatewayService,
  env: Record<string, string | undefined>,
): ManagedGatewayBinding {
  const unitPath = svc.sourcePath;
  const unitName = resolveSystemdTemplateInstanceName(svc.label, {
    OPENCLAW_SYSTEMD_UNIT: svc.label,
  });
  const systemdReadTarget = unitPath ? { scope: svc.scope, unitName, unitPath } : undefined;
  return {
    scope: svc.scope,
    ...(systemdReadTarget ? { systemdReadTarget } : {}),
    env: hostBindingEnv(env, { OPENCLAW_SYSTEMD_UNIT: unitName }),
  };
}

function bindingFromLaunchdService(
  svc: ExtraGatewayService,
  env: Record<string, string | undefined>,
): ManagedGatewayBinding {
  const plistPath = svc.sourcePath;
  return {
    scope: svc.scope,
    ...(plistPath ? { launchAgentPlistPath: plistPath } : {}),
    env: hostBindingEnv(env, { OPENCLAW_LAUNCHD_LABEL: svc.label }),
  };
}

function bindingFromWindowsTask(
  name: string,
  profile: string,
  env: Record<string, string | undefined>,
): ManagedGatewayBinding {
  return {
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
  options: { requireComplete?: boolean; includeInvoking?: boolean } = {},
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

  if (options.includeInvoking) {
    push({ env });
  }
  try {
    const { services, errors } = await listManagedOpenClawGatewayServices(env, {
      requireComplete: true,
    });
    if (options.requireComplete && errors.length > 0) {
      throw new Error("Managed Gateway inventory could not be completely inspected.");
    }
    // Best-effort callers retain known bindings; automatic writers require complete discovery.
    for (const svc of services) {
      if (svc.platform === "linux") {
        push(bindingFromSystemdService(svc, env));
        continue;
      }
      if (svc.platform === "darwin") {
        push(bindingFromLaunchdService(svc, env));
        continue;
      }
      if (svc.windowsProfile === undefined) {
        continue;
      }
      if (svc.windowsStartupEntry !== undefined) {
        push({
          scope: "user",
          windowsStartupEntry: svc.windowsStartupEntry,
          env: hostBindingEnv(env, profileEnvFields(svc.windowsProfile)),
        });
        continue;
      }
      push(bindingFromWindowsTask(svc.label, svc.windowsProfile, env));
    }
  } catch (error) {
    if (options.requireComplete || hasCommandProcessCleanupError(error)) {
      throw error;
    }
  }

  return results;
}

/** Name an observed owner; these diagnostics confer no control authority. */
export function describeManagedGatewayBinding(
  binding: ManagedGatewayBinding,
  state: LoadedLaunchAgentState,
): string {
  if (state.launchAgent) {
    return `launchd job ${JSON.stringify(state.launchAgent.target)} loaded from ${JSON.stringify(state.launchAgent.sourcePath)}`;
  }
  if (binding.windowsStartupEntry) {
    return `Startup entry ${JSON.stringify(binding.windowsStartupEntry)}`;
  }
  if (process.platform === "win32") {
    return `Scheduled Task ${JSON.stringify(resolveTaskName(binding.env))}`;
  }
  const target = binding.systemdReadTarget;
  const unit =
    state.runtime?.systemd?.unit ??
    target?.unitName ??
    `${resolveSystemdServiceName(binding.env)}.service`;
  return `systemd ${state.runtime?.systemd?.scope ?? target?.scope ?? "user"} unit ${JSON.stringify(unit)}`;
}
