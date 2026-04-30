import fs from "node:fs/promises";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveArchiveKind } from "../infra/archive.js";
import { resolveUserPath } from "../utils.js";
import { installPluginFromClawHub } from "./clawhub.js";
import { resolveDefaultPluginExtensionsDir } from "./install-paths.js";
import { buildPluginInstallPersistState } from "./install-persist-core.js";
import { commitPluginInstallRecordsWithConfig } from "./install-record-commit.js";
import {
  installPluginFromNpmSpec,
  installPluginFromPath,
  type InstallPluginResult,
} from "./install.js";
import { loadInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";
import { buildNpmResolutionInstallFields, type PluginInstallUpdate } from "./installs.js";
import {
  createMemoryLogger,
  enqueuePluginManagementMutation,
  installFailureExtras,
  installFailureKind,
  pluginManagementFailure,
  readPluginMutationSnapshot,
  refreshRegistryAfterPluginMutation,
} from "./management-core.js";

export type PluginManagementInstallParams =
  | {
      source: "path";
      path: string;
      force?: boolean;
      link?: boolean;
      dangerouslyForceUnsafeInstall?: boolean;
      timeoutMs?: number;
    }
  | {
      source: "npm";
      spec: string;
      force?: boolean;
      pin?: boolean;
      dangerouslyForceUnsafeInstall?: boolean;
      timeoutMs?: number;
    }
  | {
      source: "clawhub";
      spec: string;
      force?: boolean;
      dangerouslyForceUnsafeInstall?: boolean;
      timeoutMs?: number;
    };

function resolveInstallMode(force?: boolean): "install" | "update" {
  return force ? "update" : "install";
}

function resolvePluginInstallRecord(params: {
  request: PluginManagementInstallParams;
  result: Extract<InstallPluginResult, { ok: true }>;
}): Omit<PluginInstallUpdate, "pluginId"> {
  if (params.request.source === "npm") {
    return {
      source: "npm",
      spec: params.request.pin
        ? `${params.result.npmResolution?.name ?? params.request.spec}@${params.result.npmResolution?.version ?? params.result.version ?? "latest"}`
        : params.request.spec,
      installPath: params.result.targetDir,
      version: params.result.version,
      ...buildNpmResolutionInstallFields(params.result.npmResolution),
    };
  }
  if (params.request.source === "clawhub") {
    const result = params.result as Extract<
      Awaited<ReturnType<typeof installPluginFromClawHub>>,
      { ok: true }
    >;
    return {
      source: "clawhub",
      spec: params.request.spec,
      installPath: result.targetDir,
      version: result.version,
      integrity: result.clawhub.integrity,
      resolvedAt: result.clawhub.resolvedAt,
      clawhubUrl: result.clawhub.clawhubUrl,
      clawhubPackage: result.clawhub.clawhubPackage,
      clawhubFamily: result.clawhub.clawhubFamily,
      clawhubChannel: result.clawhub.clawhubChannel,
    };
  }
  const resolved = resolveUserPath(params.request.path);
  return {
    source: resolveArchiveKind(resolved) ? "archive" : "path",
    sourcePath: resolved,
    installPath: params.result.targetDir,
    version: params.result.version,
  };
}

async function commitManagedInstall(params: {
  pluginId: string;
  install: Omit<PluginInstallUpdate, "pluginId">;
  installRecords: Record<string, PluginInstallRecord>;
  config: Awaited<ReturnType<typeof readPluginMutationSnapshot>>["config"];
  baseHash?: string;
  writeOptions: Awaited<ReturnType<typeof readPluginMutationSnapshot>>["writeOptions"];
}) {
  const installState = await buildPluginInstallPersistState({
    config: params.config,
    pluginId: params.pluginId,
    install: params.install,
    installRecords: params.installRecords,
  });
  await commitPluginInstallRecordsWithConfig({
    previousInstallRecords: params.installRecords,
    nextInstallRecords: installState.installRecords,
    nextConfig: installState.config,
    baseHash: params.baseHash,
    writeOptions: params.writeOptions,
  });
  const refreshWarnings = await refreshRegistryAfterPluginMutation({
    config: installState.config,
    installRecords: installState.installRecords,
    reason: "source-changed",
  });
  return { installState, refreshWarnings };
}

export async function installManagedPlugin(params: PluginManagementInstallParams) {
  return await enqueuePluginManagementMutation(async () => {
    const snapshot = await readPluginMutationSnapshot();
    const installRecords = await loadInstalledPluginIndexInstallRecords();
    const logger = createMemoryLogger();
    const extensionsDir = resolveDefaultPluginExtensionsDir();
    const mode = resolveInstallMode(params.force);

    let result: InstallPluginResult | Awaited<ReturnType<typeof installPluginFromClawHub>>;
    if (params.source === "path") {
      const resolved = resolveUserPath(params.path);
      if (params.link) {
        if (params.force) {
          return pluginManagementFailure(
            "invalid-request",
            'plugins.install source "path" cannot combine "link" and "force"',
          );
        }
        const stat = await fs.stat(resolved).catch(() => null);
        if (!stat?.isDirectory()) {
          return pluginManagementFailure(
            "invalid-request",
            'plugins.install "link" requires a local directory path',
          );
        }
        const probe = await installPluginFromPath({
          path: resolved,
          mode,
          dryRun: true,
          extensionsDir,
          dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
          timeoutMs: params.timeoutMs,
          logger,
        });
        if (!probe.ok) {
          return pluginManagementFailure(installFailureKind(probe.code), probe.error, {
            ...installFailureExtras(probe.code, logger.messages),
          });
        }
        const existing = snapshot.config.plugins?.load?.paths ?? [];
        const merged = Array.from(new Set([...existing, resolved]));
        const { installState, refreshWarnings } = await commitManagedInstall({
          pluginId: probe.pluginId,
          install: {
            source: "path",
            sourcePath: resolved,
            installPath: resolved,
            version: probe.version,
          },
          installRecords,
          config: {
            ...snapshot.config,
            plugins: {
              ...snapshot.config.plugins,
              load: {
                ...snapshot.config.plugins?.load,
                paths: merged,
              },
            },
          },
          baseHash: snapshot.baseHash,
          writeOptions: snapshot.writeOptions,
        });
        return {
          ok: true as const,
          pluginId: probe.pluginId,
          targetDir: resolved,
          install: installState.installRecords[probe.pluginId],
          warnings: [...installState.warnings, ...refreshWarnings],
          logs: logger.messages,
        };
      }
      result = await installPluginFromPath({
        path: resolved,
        mode,
        extensionsDir,
        dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
        timeoutMs: params.timeoutMs,
        logger,
      });
    } else if (params.source === "npm") {
      result = await installPluginFromNpmSpec({
        spec: params.spec,
        mode,
        extensionsDir,
        dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
        timeoutMs: params.timeoutMs,
        logger,
      });
    } else {
      result = await installPluginFromClawHub({
        spec: params.spec,
        mode,
        extensionsDir,
        dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
        timeoutMs: params.timeoutMs,
        logger,
      });
    }
    if (!result.ok) {
      return pluginManagementFailure(installFailureKind(result.code), result.error, {
        ...installFailureExtras(result.code, logger.messages),
      });
    }

    const { installState, refreshWarnings } = await commitManagedInstall({
      pluginId: result.pluginId,
      install: resolvePluginInstallRecord({ request: params, result }),
      installRecords,
      config: snapshot.config,
      baseHash: snapshot.baseHash,
      writeOptions: snapshot.writeOptions,
    });
    return {
      ok: true as const,
      pluginId: result.pluginId,
      targetDir: result.targetDir,
      version: result.version,
      install: installState.installRecords[result.pluginId],
      warnings: [...installState.warnings, ...refreshWarnings],
      logs: logger.messages,
    };
  });
}
