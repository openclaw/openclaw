/**
 * Dynamic loader for hook handlers
 *
 * Loads hook handlers from external modules based on configuration
 * and from directory-based discovery (bundled, managed, workspace)
 */

import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isPathInsideWithRealpath } from "../security/scan-paths.js";
import { resolveHookConfig } from "./config.js";
import { shouldIncludeHook } from "./config.js";
import type { InternalHookHandler } from "./internal-hooks.js";
import { registerInternalHook } from "./internal-hooks.js";
import { importFileModule, resolveFunctionModuleExport } from "./module-loader.js";
import { loadWorkspaceHookEntries } from "./workspace.js";

const log = createSubsystemLogger("hooks:loader");

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
 * const config = await loadConfig();
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
  // Check if hooks are enabled
  if (!cfg.hooks?.internal?.enabled) {
    return 0;
  }

  let loadedCount = 0;

  // 1. Load hooks from directories (new system)
  try {
    const hookEntries = loadWorkspaceHookEntries(workspaceDir, {
      config: cfg,
      managedHooksDir: opts?.managedHooksDir,
      bundledHooksDir: opts?.bundledHooksDir,
    });

    // Filter by eligibility
    const eligible = hookEntries.filter((entry) => shouldIncludeHook({ entry, config: cfg }));

    for (const entry of eligible) {
      const hookConfig = resolveHookConfig(cfg, entry.hook.name);

      // Skip if explicitly disabled in config
      if (hookConfig?.enabled === false) {
        continue;
      }

      try {
        if (
          !isPathInsideWithRealpath(entry.hook.baseDir, entry.hook.handlerPath, {
            requireRealpath: true,
          })
        ) {
          log.error(
            `Hook '${entry.hook.name}' handler path resolves outside hook directory: ${entry.hook.handlerPath}`,
          );
          continue;
        }
        // Get handler function (default or named export)
        const exportName = entry.metadata?.export ?? "default";
        const mod = await importFileModule({
          modulePath: entry.hook.handlerPath,
          cacheBust: true,
        });
        const handler = resolveFunctionModuleExport<InternalHookHandler>({
          mod,
          exportName,
        });

        if (!handler) {
          log.error(`Handler '${exportName}' from ${entry.hook.name} is not a function`);
          continue;
        }

        // Register for all events listed in metadata
        const events = entry.metadata?.events ?? [];
        if (events.length === 0) {
          log.warn(`Hook '${entry.hook.name}' has no events defined in metadata`);
          continue;
        }

        for (const event of events) {
          registerInternalHook(event, handler);
        }

        log.info(
          `Registered hook: ${entry.hook.name} -> ${events.join(", ")}${exportName !== "default" ? ` (export: ${exportName})` : ""}`,
        );
        loadedCount++;
      } catch (err) {
        log.error(
          `Failed to load hook ${entry.hook.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    log.error(
      `Failed to load directory-based hooks: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 2. Load legacy config handlers (backwards compatibility)
  const handlers = cfg.hooks.internal.handlers ?? [];
  for (const handlerConfig of handlers) {
    try {
      // Legacy handler paths: keep them workspace-relative.
      const rawModule = handlerConfig.module.trim();
      if (!rawModule) {
        log.error("Handler module path is empty");
        continue;
      }
      if (path.isAbsolute(rawModule)) {
        log.error(
          `Handler module path must be workspace-relative (got absolute path): ${rawModule}`,
        );
        continue;
      }
      const baseDir = path.resolve(workspaceDir);
      const modulePath = path.resolve(baseDir, rawModule);
      const rel = path.relative(baseDir, modulePath);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
        log.error(`Handler module path must stay within workspaceDir: ${rawModule}`);
        continue;
      }
      if (
        !isPathInsideWithRealpath(baseDir, modulePath, {
          requireRealpath: true,
        })
      ) {
        log.error(
          `Handler module path resolves outside workspaceDir after symlink resolution: ${rawModule}`,
        );
        continue;
      }

      // Get the handler function
      const exportName = handlerConfig.export ?? "default";
      const mod = await importFileModule({
        modulePath,
        cacheBust: true,
      });
      const handler = resolveFunctionModuleExport<InternalHookHandler>({
        mod,
        exportName,
      });

      if (!handler) {
        log.error(`Handler '${exportName}' from ${modulePath} is not a function`);
        continue;
      }

      registerInternalHook(handlerConfig.event, handler);
      log.info(
        `Registered hook (legacy): ${handlerConfig.event} -> ${modulePath}${exportName !== "default" ? `#${exportName}` : ""}`,
      );
      loadedCount++;
    } catch (err) {
      log.error(
        `Failed to load hook handler from ${handlerConfig.module}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return loadedCount;
}
