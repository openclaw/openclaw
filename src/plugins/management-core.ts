import { readConfigFileSnapshotForWrite, replaceConfigFile } from "../config/config.js";
import type { ConfigWriteOptions } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  refreshPluginRegistryAfterConfigMutation as refreshPluginRegistryAfterConfigMutationBase,
  type PluginRegistryRefreshTrace,
} from "./registry-refresh.js";

export type PluginManagementLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type PluginMutationSnapshot = {
  config: OpenClawConfig;
  baseHash?: string;
  writeOptions: ConfigWriteOptions;
};

export type PluginManagementErrorKind =
  | "invalid-request"
  | "not-found"
  | "conflict"
  | "unavailable";

export type PluginManagementError = {
  kind: PluginManagementErrorKind;
  message: string;
};

export type PluginManagementFailure = {
  ok: false;
  error: PluginManagementError;
  code?: string;
  logs?: string[];
};

export function createMemoryLogger(): Required<PluginManagementLogger> & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    info: (message) => {
      messages.push(message);
    },
    warn: (message) => {
      messages.push(message);
    },
  };
}

export function pluginManagementError(
  kind: PluginManagementErrorKind,
  message: string,
): PluginManagementError {
  return { kind, message };
}

export function pluginManagementFailure(
  kind: PluginManagementErrorKind,
  message: string,
  extras: Omit<PluginManagementFailure, "ok" | "error"> = {},
): PluginManagementFailure {
  return {
    ok: false,
    error: pluginManagementError(kind, message),
    ...extras,
  };
}

export function pluginNotFoundFailure(id: string): PluginManagementFailure {
  return pluginManagementFailure("not-found", `Plugin not found: ${id}`);
}

export function installFailureKind(code: string | undefined): PluginManagementErrorKind {
  if (!code) {
    return "unavailable";
  }
  if (code === "npm_package_not_found") {
    return "not-found";
  }
  if (code === "security_scan_failed" || code === "unknown_host_version") {
    return "unavailable";
  }
  return "invalid-request";
}

export function installFailureExtras(code: string | undefined, logs: string[]) {
  return {
    ...(code !== undefined ? { code } : {}),
    logs,
  };
}

let pluginManagementMutationTail: Promise<unknown> = Promise.resolve();

export function enqueuePluginManagementMutation<T>(operation: () => Promise<T>): Promise<T> {
  const run = pluginManagementMutationTail.catch(() => undefined).then(operation);
  pluginManagementMutationTail = run.catch(() => undefined);
  return run;
}

export async function readPluginMutationSnapshot(): Promise<PluginMutationSnapshot> {
  const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
  if (!snapshot.valid) {
    throw new Error("Config invalid; run `openclaw doctor --fix` before managing plugins.");
  }
  return {
    config: snapshot.sourceConfig,
    ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
    writeOptions,
  };
}

const skipPluginRegistryRefreshTrace: PluginRegistryRefreshTrace = async (_phase, fn) => await fn();

export async function refreshRegistryAfterPluginMutation(params: {
  config: OpenClawConfig;
  installRecords?: Record<string, PluginInstallRecord>;
  reason: "source-changed" | "policy-changed" | "manual";
}): Promise<string[]> {
  return await refreshPluginRegistryAfterConfigMutationBase({
    config: params.config,
    reason: params.reason,
    ...(params.installRecords ? { installRecords: params.installRecords } : {}),
    trace: skipPluginRegistryRefreshTrace,
  });
}

export async function replacePluginConfig(params: {
  nextConfig: OpenClawConfig;
  baseHash?: string;
  writeOptions: ConfigWriteOptions;
}): Promise<void> {
  await replaceConfigFile({
    nextConfig: params.nextConfig,
    ...(params.baseHash !== undefined ? { baseHash: params.baseHash } : {}),
    writeOptions: params.writeOptions,
    afterWrite: { mode: "auto" },
  });
}
