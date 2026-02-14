/**
 * Dynamic loader for hook handlers
 *
 * Loads hook handlers from external modules based on configuration
 * and from directory-based discovery (bundled, managed, workspace)
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenClawConfig } from "../config/config.js";
import type { InternalHookHandler } from "./internal-hooks.js";
import { CONFIG_DIR } from "../utils.js";
import { resolveBundledHooksDir } from "./bundled-dir.js";
import { resolveHookConfig } from "./config.js";
import { shouldIncludeHook } from "./config.js";
import { registerInternalHook } from "./internal-hooks.js";
import { validateModulePath, validateExtraHooksDir, getErrorDescription } from "./security.js";
import { loadWorkspaceHookEntries } from "./workspace.js";

/**
 * Builds the allowlist of base directories for hook module loading.
 */
function buildAllowedBaseDirs(cfg: OpenClawConfig, workspaceDir: string): string[] {
  const allowedDirs: string[] = [];

  try {
    const bundledDir = resolveBundledHooksDir();
    if (bundledDir) {
      allowedDirs.push(bundledDir);
    }
  } catch {
    // bundled dir not found - continue without it
  }

  allowedDirs.push(path.join(CONFIG_DIR, "hooks"));

  if (workspaceDir) {
    allowedDirs.push(path.join(workspaceDir, "hooks"));
  }

  const extraDirs = cfg.hooks?.internal?.load?.extraDirs ?? [];
  for (const extraDir of extraDirs) {
    if (typeof extraDir === "string" && extraDir.trim()) {
      const validation = validateExtraHooksDir(extraDir.trim());
      if (validation.valid) {
        allowedDirs.push(validation.path);
      } else {
        console.warn(
          `[security] Rejected invalid extra hooks directory: ${getErrorDescription(validation.reason)}`,
        );
      }
    }
  }

  return allowedDirs;
}

/**
 * Validates a handler path and imports it as a module.
 * Rejects paths outside the allowed directories to prevent CWE-94 code injection.
 */
async function secureImportHookModule(
  handlerPath: string,
  allowedBaseDirs: string[],
  hookName: string,
): Promise<Record<string, unknown>> {
  const validation = validateModulePath(handlerPath, {
    allowedBaseDirs,
    resolveSymlinks: true,
  });

  if (!validation.valid) {
    const errorMsg = `Invalid hook path for '${hookName}': ${getErrorDescription(validation.reason)}`;
    console.error(`[security] ${errorMsg}`);
    throw new Error(errorMsg);
  }

  const url = pathToFileURL(validation.path).href;
  const cacheBustedUrl = `${url}?t=${Date.now()}`;
  return (await import(cacheBustedUrl)) as Record<string, unknown>;
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
 * const config = await loadConfig();
 * const workspaceDir = resolveAgentWorkspaceDir(config, agentId);
 * const count = await loadInternalHooks(config, workspaceDir);
 * console.log(`Loaded ${count} hook handlers`);
 * ```
 */
export async function loadInternalHooks(
  cfg: OpenClawConfig,
  workspaceDir: string,
): Promise<number> {
  if (!cfg.hooks?.internal?.enabled) {
    return 0;
  }

  let loadedCount = 0;
  const allowedBaseDirs = buildAllowedBaseDirs(cfg, workspaceDir);

  // 1. Load hooks from directories (new system)
  try {
    const hookEntries = loadWorkspaceHookEntries(workspaceDir, { config: cfg });

    // Filter by eligibility
    const eligible = hookEntries.filter((entry) => shouldIncludeHook({ entry, config: cfg }));

    for (const entry of eligible) {
      const hookConfig = resolveHookConfig(cfg, entry.hook.name);

      // Skip if explicitly disabled in config
      if (hookConfig?.enabled === false) {
        continue;
      }

      try {
        const mod = await secureImportHookModule(
          entry.hook.handlerPath,
          allowedBaseDirs,
          entry.hook.name,
        );

        // Get handler function (default or named export)
        const exportName = entry.metadata?.export ?? "default";
        const handler = mod[exportName];

        if (typeof handler !== "function") {
          console.error(
            `Hook error: Handler '${exportName}' from ${entry.hook.name} is not a function`,
          );
          continue;
        }

        // Register for all events listed in metadata
        const events = entry.metadata?.events ?? [];
        if (events.length === 0) {
          console.warn(`Hook warning: Hook '${entry.hook.name}' has no events defined in metadata`);
          continue;
        }

        for (const event of events) {
          registerInternalHook(event, handler as InternalHookHandler);
        }

        console.log(
          `Registered hook: ${entry.hook.name} -> ${events.join(", ")}${exportName !== "default" ? ` (export: ${exportName})` : ""}`,
        );
        loadedCount++;
      } catch (err) {
        console.error(
          `Failed to load hook ${entry.hook.name}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  } catch (err) {
    console.error(
      "Failed to load directory-based hooks:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // 2. Load legacy config handlers (backwards compatibility)
  const handlers = cfg.hooks.internal.handlers ?? [];
  for (const handlerConfig of handlers) {
    try {
      const modulePath = path.isAbsolute(handlerConfig.module)
        ? handlerConfig.module
        : path.join(CONFIG_DIR, "hooks", handlerConfig.module);

      const mod = await secureImportHookModule(
        modulePath,
        allowedBaseDirs,
        `legacy-${handlerConfig.event}`,
      );

      const exportName = handlerConfig.export ?? "default";
      const handler = mod[exportName];

      if (typeof handler !== "function") {
        console.error(`Hook error: Handler '${exportName}' from legacy config is not a function`);
        continue;
      }

      registerInternalHook(handlerConfig.event, handler as InternalHookHandler);
      console.log(
        `Registered hook (legacy): ${handlerConfig.event} -> ${path.basename(handlerConfig.module)}${exportName !== "default" ? `#${exportName}` : ""}`,
      );
      loadedCount++;
    } catch (err) {
      console.error(
        `Failed to load legacy hook handler from ${path.basename(handlerConfig.module)}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return loadedCount;
}
