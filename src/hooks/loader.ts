/**
 * Dynamic loader for hook handlers
 *
 * Loads hook handlers from external modules based on configuration
 * and from directory-based discovery (bundled, managed, workspace)
 */

import fs from "node:fs";
import path from "node:path";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openRootFile } from "../infra/boundary-file-read.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { shouldIncludeHook } from "./config.js";
import { hasConfiguredInternalHooks, resolveConfiguredInternalHookNames } from "./configured.js";
import { buildImportUrl } from "./import-url.js";
import type { InternalHookHandler } from "./internal-hooks.js";
import { registerInternalHook, unregisterInternalHook } from "./internal-hooks.js";
import { getLegacyInternalHookHandlers } from "./legacy-config.js";
import { resolveFunctionModuleExport } from "./module-loader.js";
import { loadWorkspaceHookEntries } from "./workspace.js";

const log = createSubsystemLogger("hooks:loader");
const LOADED_INTERNAL_HOOK_REGISTRATIONS_KEY = Symbol.for(
  "openclaw.loadedInternalHookRegistrations",
);
const loadedHookRegistrations = resolveGlobalSingleton<
  Array<{ event: string; handler: InternalHookHandler }>
>(LOADED_INTERNAL_HOOK_REGISTRATIONS_KEY, () => []);

function safeLogValue(value: string): string {
  return sanitizeForLog(value);
}

function isNonEmptyRelativePathInsideRoot(relativePath: string): boolean {
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function maybeWarnTrustedHookSource(source: string): void {
  if (source === "openclaw-workspace") {
    log.warn(
      "Loading workspace hook code into the gateway process. Workspace hooks are trusted local code.",
      undefined,
      {
        event: "hooks.loader.workspace_hook.loading",
        outcome: "warning",
        reason: "warning",
      },
    );
    return;
  }
  if (source === "openclaw-managed") {
    log.warn(
      "Loading managed hook code into the gateway process. Managed hooks are trusted local code.",
      undefined,
      {
        event: "hooks.loader.managed_code",
        outcome: "warning",
        reason: "trusted_local_code",
      },
    );
  }
}

function resetLoadedInternalHooks(): void {
  while (loadedHookRegistrations.length > 0) {
    const registration = loadedHookRegistrations.pop();
    if (!registration) {
      continue;
    }
    unregisterInternalHook(registration.event, registration.handler);
  }
}

/**
 * Load and register all hook handlers
 *
 * Loads hooks from both:
 * 1. Directory-based discovery (bundled, managed, workspace)
 * 2. Legacy config handlers (backwards compatibility)
 *
 * @param cfg - OpenClaw configuration
 * @param workspaceDir - Workspace directory for hook discovery
 * @returns Number of handlers successfully loaded
 *
 * @example
 * ```ts
 * const config = await getRuntimeConfig();
 * const workspaceDir = resolveAgentWorkspaceDir(config, agentId);
 * const count = await loadInternalHooks(config, workspaceDir);
 * console.log(`Loaded ${count} hook handlers`);
 * ```
 */
export async function loadInternalHooks(
  cfg: OpenClawConfig,
  workspaceDir: string,
  opts?: {
    managedHooksDir?: string;
    bundledHooksDir?: string;
  },
): Promise<number> {
  resetLoadedInternalHooks();

  if (!hasConfiguredInternalHooks(cfg)) {
    return 0;
  }

  let loadedCount = 0;
  const configuredNames = resolveConfiguredInternalHookNames(cfg);

  // 1. Load hooks from directories (new system)
  try {
    const hookEntries = loadWorkspaceHookEntries(workspaceDir, {
      config: cfg,
      managedHooksDir: opts?.managedHooksDir,
      bundledHooksDir: opts?.bundledHooksDir,
    });

    // Filter by eligibility
    const eligible = hookEntries.filter((entry) => {
      if (configuredNames && !configuredNames.has(entry.hook.name)) {
        return false;
      }
      return shouldIncludeHook({ entry, config: cfg });
    });

    for (const entry of eligible) {
      try {
        const hookBaseDir = resolveExistingRealpath(entry.hook.baseDir);
        if (!hookBaseDir) {
          log.error(
            `Hook '${safeLogValue(entry.hook.name)}' base directory is no longer readable: ${safeLogValue(entry.hook.baseDir)}`,
            undefined,
            {
              event: "hooks.loader.hook",
              outcome: "failure",
              reason: "base_directory_unreadable",
            },
          );
          continue;
        }
        const opened = await openRootFile({
          absolutePath: entry.hook.handlerPath,
          rootPath: hookBaseDir,
          boundaryLabel: "hook directory",
        });
        if (!opened.ok) {
          log.error(
            `Hook '${safeLogValue(entry.hook.name)}' handler path fails boundary checks: ${safeLogValue(entry.hook.handlerPath)}`,
            undefined,
            {
              event: "hooks.loader.hook",
              outcome: "failure",
              reason: "boundary_check_failed",
            },
          );
          continue;
        }
        const safeHandlerPath = opened.path;
        fs.closeSync(opened.fd);
        maybeWarnTrustedHookSource(entry.hook.source);

        // Import handler module — only cache-bust mutable (workspace/managed) hooks
        const importUrl = buildImportUrl(safeHandlerPath, entry.hook.source);
        const mod = (await import(importUrl)) as Record<string, unknown>;

        // Get handler function (default or named export)
        const exportName = entry.metadata?.export ?? "default";
        const handler = resolveFunctionModuleExport<InternalHookHandler>({
          mod,
          exportName,
        });

        if (!handler) {
          log.error(
            `Handler '${safeLogValue(exportName)}' from ${safeLogValue(entry.hook.name)} is not a function`,
            undefined,
            { event: "hooks.loader.handler", outcome: "failure", reason: "not_function" },
          );
          continue;
        }

        // Register for all events listed in metadata
        const events = entry.metadata?.events ?? [];
        if (events.length === 0) {
          log.warn(
            `Hook '${safeLogValue(entry.hook.name)}' has no events defined in metadata`,
            undefined,
            {
              event: "hooks.loader.hook",
              outcome: "warning",
              reason: "no_events",
            },
          );
          continue;
        }

        for (const event of events) {
          registerInternalHook(event, handler);
          loadedHookRegistrations.push({ event, handler });
        }

        log.debug(
          `Registered hook: ${safeLogValue(entry.hook.name)} -> ${events.map((event) => safeLogValue(event)).join(", ")}${exportName !== "default" ? ` (export: ${safeLogValue(exportName)})` : ""}`,
          undefined,
          { event: "hooks.loader.hook", outcome: "success", reason: "registered" },
        );
        loadedCount++;
      } catch (err) {
        log.error(
          `Failed to load hook ${safeLogValue(entry.hook.name)}: ${safeLogValue(formatErrorMessage(err))}`,
          undefined,
          { event: "hooks.loader.load.hook", outcome: "failure", reason: "failed" },
        );
      }
    }
  } catch (err) {
    log.error(
      `Failed to load directory-based hooks: ${safeLogValue(formatErrorMessage(err))}`,
      undefined,
      {
        event: "hooks.loader.directory",
        outcome: "failure",
        reason: "failed",
      },
    );
  }

  // 2. Load legacy config handlers (backwards compatibility)
  const handlers = getLegacyInternalHookHandlers(cfg);
  for (const handlerConfig of handlers) {
    try {
      // Legacy handler paths: keep them workspace-relative.
      const rawModule = handlerConfig.module.trim();
      if (!rawModule) {
        log.error("Handler module path is empty", undefined, {
          event: "hooks.loader.handler_module_path",
          outcome: "failure",
          reason: "empty",
        });
        continue;
      }
      if (path.isAbsolute(rawModule)) {
        log.error(
          `Handler module path must be workspace-relative (got absolute path): ${safeLogValue(rawModule)}`,
          undefined,
          {
            event: "hooks.loader.handler_module_path",
            outcome: "failure",
            reason: "absolute_path",
          },
        );
        continue;
      }
      const baseDir = path.resolve(workspaceDir);
      const modulePath = path.resolve(baseDir, rawModule);
      const baseDirReal = resolveExistingRealpath(baseDir);
      if (!baseDirReal) {
        log.error(
          `Workspace directory is no longer readable while loading hooks: ${safeLogValue(baseDir)}`,
          undefined,
          {
            event: "hooks.loader.workspace",
            outcome: "failure",
            reason: "unreadable",
          },
        );
        continue;
      }
      const modulePathSafe = resolveExistingRealpath(modulePath);
      if (!modulePathSafe) {
        log.error(
          `Handler module path could not be resolved with realpath: ${safeLogValue(rawModule)}`,
          undefined,
          {
            event: "hooks.loader.handler_module_path",
            outcome: "failure",
            reason: "realpath_failed",
          },
        );
        continue;
      }
      const rel = path.relative(baseDirReal, modulePathSafe);
      if (!isNonEmptyRelativePathInsideRoot(rel)) {
        log.error(
          `Handler module path must stay within workspaceDir: ${safeLogValue(rawModule)}`,
          undefined,
          {
            event: "hooks.loader.handler_module_path",
            outcome: "failure",
            reason: "outside_workspace",
          },
        );
        continue;
      }
      const opened = await openRootFile({
        absolutePath: modulePathSafe,
        rootPath: baseDirReal,
        boundaryLabel: "workspace directory",
      });
      if (!opened.ok) {
        log.error(
          `Handler module path fails boundary checks under workspaceDir: ${safeLogValue(rawModule)}`,
          undefined,
          {
            event: "hooks.loader.handler_module_path",
            outcome: "failure",
            reason: "boundary_check_failed",
          },
        );
        continue;
      }
      const safeModulePath = opened.path;
      fs.closeSync(opened.fd);
      log.warn(
        `Loading legacy internal hook module from workspace path ${safeLogValue(rawModule)}. Legacy hook modules are trusted local code.`,
        undefined,
        {
          event: "hooks.loader.legacy_module.loading",
          outcome: "warning",
          reason: "trusted_local_code",
        },
      );

      // Legacy handlers are always workspace-relative, so use mtime-based cache busting
      const importUrl = buildImportUrl(safeModulePath, "openclaw-workspace");
      const mod = (await import(importUrl)) as Record<string, unknown>;

      // Get the handler function
      const exportName = handlerConfig.export ?? "default";
      const handler = resolveFunctionModuleExport<InternalHookHandler>({
        mod,
        exportName,
      });

      if (!handler) {
        log.error(
          `Handler '${safeLogValue(exportName)}' from ${safeLogValue(modulePath)} is not a function`,
          undefined,
          { event: "hooks.loader.handler", outcome: "failure", reason: "not_function" },
        );
        continue;
      }

      registerInternalHook(handlerConfig.event, handler);
      loadedHookRegistrations.push({ event: handlerConfig.event, handler });
      log.debug(
        `Registered hook (legacy): ${safeLogValue(handlerConfig.event)} -> ${safeLogValue(modulePath)}${exportName !== "default" ? `#${safeLogValue(exportName)}` : ""}`,
        undefined,
        { event: "hooks.loader.legacy_hook", outcome: "success", reason: "registered" },
      );
      loadedCount++;
    } catch (err) {
      log.error(
        `Failed to load hook handler from ${safeLogValue(handlerConfig.module)}: ${safeLogValue(formatErrorMessage(err))}`,
        undefined,
        { event: "hooks.loader.load.hook.handler", outcome: "failure", reason: "failed" },
      );
    }
  }

  return loadedCount;
}

function resolveExistingRealpath(value: string): string | null {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
}
