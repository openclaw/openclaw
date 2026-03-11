/**
 * Dynamic loader for hook handlers
 *
 * Loads hook handlers from external modules based on configuration
 * and from directory-based discovery (bundled, managed, workspace)
 */

import fs from "node:fs";
import path from "node:path";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { openBoundaryFile } from "../infra/boundary-file-read.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";
import { resolveBundledHooksDir } from "./bundled-dir.js";
import { resolveHookConfig } from "./config.js";
import { shouldIncludeHook } from "./config.js";
import { buildImportUrl } from "./import-url.js";
import type { InternalHookEvent, InternalHookHandler } from "./internal-hooks.js";
import { registerInternalHook } from "./internal-hooks.js";
import { resolveFunctionModuleExport } from "./module-loader.js";
import type { HookEntry } from "./types.js";
import { loadHookEntriesFromDir, loadWorkspaceHookEntries } from "./workspace.js";

const log = createSubsystemLogger("hooks:loader");

type LoaderOptions = {
  managedHooksDir?: string;
  bundledHooksDir?: string;
};

type HookHandlerWrapper = (entry: HookEntry, handler: InternalHookHandler) => InternalHookHandler;

type LoadedHookModule = {
  handler: InternalHookHandler;
  exportName: string;
};

type WorkspaceOverrideMap = Map<string, Set<string>>;

/**
 * Startup loader for multi-agent gateways.
 *
 * Shared hooks are registered once, while workspace-local hooks are loaded for
 * every configured workspace and wrapped with a scope guard before they enter
 * the global registry.
 */
export async function loadInternalHooksForStartup(
  cfg: OpenClawConfig,
  defaultWorkspaceDir: string,
  workspaceDirs: readonly string[],
  opts?: LoaderOptions,
): Promise<number> {
  if (!cfg.hooks?.internal?.enabled) {
    return 0;
  }

  let loadedCount = 0;
  const normalizedWorkspaceDirs = normalizeWorkspaceDirs([defaultWorkspaceDir, ...workspaceDirs]);
  const workspaceEntriesByDir = new Map<string, HookEntry[]>();
  for (const workspaceDir of normalizedWorkspaceDirs) {
    try {
      workspaceEntriesByDir.set(workspaceDir, loadWorkspaceLocalHookEntries(workspaceDir));
    } catch (err) {
      log.error(
        `Failed to load hooks for workspace ${workspaceDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const overriddenWorkspacesByHookName = buildWorkspaceOverrideMap(workspaceEntriesByDir);

  try {
    loadedCount += await registerHookEntries(cfg, loadSharedHookEntries(cfg, opts), {
      wrapHandler: (entry, handler) =>
        createSharedHookHandler({
          cfg,
          handler,
          overriddenWorkspaces: overriddenWorkspacesByHookName.get(entry.hook.name),
        }),
    });
  } catch (err) {
    log.error(`Failed to load shared hooks: ${err instanceof Error ? err.message : String(err)}`);
  }

  for (const [workspaceDir, entries] of workspaceEntriesByDir) {
    try {
      loadedCount += await registerHookEntries(cfg, entries, {
        wrapHandler: (_entry, handler) =>
          createWorkspaceScopedHandler({
            cfg,
            handler,
            workspaceDir,
          }),
      });
    } catch (err) {
      log.error(
        `Failed to load hooks for workspace ${workspaceDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  loadedCount += await registerLegacyHookHandlers(cfg, defaultWorkspaceDir);
  return loadedCount;
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
  opts?: LoaderOptions,
): Promise<number> {
  if (!cfg.hooks?.internal?.enabled) {
    return 0;
  }

  let loadedCount = 0;

  try {
    loadedCount += await registerHookEntries(
      cfg,
      loadWorkspaceHookEntries(workspaceDir, {
        config: cfg,
        managedHooksDir: opts?.managedHooksDir,
        bundledHooksDir: opts?.bundledHooksDir,
      }),
    );
  } catch (err) {
    log.error(
      `Failed to load directory-based hooks: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  loadedCount += await registerLegacyHookHandlers(cfg, workspaceDir);
  return loadedCount;
}

async function registerHookEntries(
  cfg: OpenClawConfig,
  entries: readonly HookEntry[],
  opts?: {
    wrapHandler?: HookHandlerWrapper;
  },
): Promise<number> {
  let loadedCount = 0;
  const eligible = entries.filter((entry) => shouldIncludeHook({ entry, config: cfg }));

  for (const entry of eligible) {
    const hookConfig = resolveHookConfig(cfg, entry.hook.name);
    if (hookConfig?.enabled === false) {
      continue;
    }

    try {
      const loaded = await loadDirectoryHookHandler(entry);
      if (!loaded) {
        continue;
      }

      const events = entry.metadata?.events ?? [];
      if (events.length === 0) {
        log.warn(`Hook '${entry.hook.name}' has no events defined in metadata`);
        continue;
      }

      const wrappedHandler = opts?.wrapHandler
        ? opts.wrapHandler(entry, loaded.handler)
        : loaded.handler;
      for (const event of events) {
        registerInternalHook(event, wrappedHandler);
      }

      log.info(
        `Registered hook: ${entry.hook.name} -> ${events.join(", ")}${loaded.exportName !== "default" ? ` (export: ${loaded.exportName})` : ""}`,
      );
      loadedCount++;
    } catch (err) {
      log.error(
        `Failed to load hook ${entry.hook.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return loadedCount;
}

async function loadDirectoryHookHandler(entry: HookEntry): Promise<LoadedHookModule | null> {
  const hookBaseDir = safeRealpathOrResolve(entry.hook.baseDir);
  const opened = await openBoundaryFile({
    absolutePath: entry.hook.handlerPath,
    rootPath: hookBaseDir,
    boundaryLabel: "hook directory",
  });
  if (!opened.ok) {
    log.error(
      `Hook '${entry.hook.name}' handler path fails boundary checks: ${entry.hook.handlerPath}`,
    );
    return null;
  }
  const safeHandlerPath = opened.path;
  fs.closeSync(opened.fd);

  const importUrl = buildImportUrl(safeHandlerPath, entry.hook.source);
  const mod = (await import(importUrl)) as Record<string, unknown>;
  const exportName = entry.metadata?.export ?? "default";
  const handler = resolveFunctionModuleExport<InternalHookHandler>({
    mod,
    exportName,
  });

  if (!handler) {
    log.error(`Handler '${exportName}' from ${entry.hook.name} is not a function`);
    return null;
  }

  return { handler, exportName };
}

async function registerLegacyHookHandlers(
  cfg: OpenClawConfig,
  workspaceDir: string,
): Promise<number> {
  let loadedCount = 0;
  const handlers = cfg.hooks?.internal?.handlers ?? [];
  for (const handlerConfig of handlers) {
    try {
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
      const baseDirReal = safeRealpathOrResolve(baseDir);
      const modulePathSafe = safeRealpathOrResolve(modulePath);
      const rel = path.relative(baseDir, modulePath);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
        log.error(`Handler module path must stay within workspaceDir: ${rawModule}`);
        continue;
      }
      const opened = await openBoundaryFile({
        absolutePath: modulePathSafe,
        rootPath: baseDirReal,
        boundaryLabel: "workspace directory",
      });
      if (!opened.ok) {
        log.error(`Handler module path fails boundary checks under workspaceDir: ${rawModule}`);
        continue;
      }
      const safeModulePath = opened.path;
      fs.closeSync(opened.fd);

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

function loadSharedHookEntries(cfg: OpenClawConfig, opts?: LoaderOptions): HookEntry[] {
  const managedHooksDir = opts?.managedHooksDir ?? path.join(CONFIG_DIR, "hooks");
  const bundledHooksDir = opts?.bundledHooksDir ?? resolveBundledHooksDir();
  const extraDirs = (cfg.hooks?.internal?.load?.extraDirs ?? [])
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);

  const extraEntries = extraDirs.flatMap((dir) =>
    loadHookEntriesFromDir({
      dir: resolveUserPath(dir),
      source: "openclaw-workspace",
    }),
  );
  const bundledEntries = bundledHooksDir
    ? loadHookEntriesFromDir({
        dir: bundledHooksDir,
        source: "openclaw-bundled",
      })
    : [];
  const managedEntries = loadHookEntriesFromDir({
    dir: managedHooksDir,
    source: "openclaw-managed",
  });

  return mergeHookEntriesByName([...extraEntries, ...bundledEntries, ...managedEntries]);
}

function loadWorkspaceLocalHookEntries(workspaceDir: string): HookEntry[] {
  return mergeHookEntriesByName(
    loadHookEntriesFromDir({
      dir: path.join(workspaceDir, "hooks"),
      source: "openclaw-workspace",
    }),
  );
}

function mergeHookEntriesByName(entries: readonly HookEntry[]): HookEntry[] {
  const merged = new Map<string, HookEntry>();
  for (const entry of entries) {
    merged.set(entry.hook.name, entry);
  }
  return Array.from(merged.values());
}

function normalizeWorkspaceDirs(workspaceDirs: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const workspaceDir of workspaceDirs) {
    const canonical = safeRealpathOrResolve(workspaceDir);
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    normalized.push(canonical);
  }
  return normalized;
}

function buildWorkspaceOverrideMap(
  workspaceEntriesByDir: ReadonlyMap<string, readonly HookEntry[]>,
): Map<string, WorkspaceOverrideMap> {
  const overrides = new Map<string, WorkspaceOverrideMap>();
  for (const [workspaceDir, entries] of workspaceEntriesByDir) {
    for (const entry of entries) {
      const workspaceOverrides = overrides.get(entry.hook.name) ?? new Map<string, Set<string>>();
      const events = workspaceOverrides.get(workspaceDir) ?? new Set<string>();
      for (const event of entry.metadata?.events ?? []) {
        events.add(event);
      }
      workspaceOverrides.set(workspaceDir, events);
      overrides.set(entry.hook.name, workspaceOverrides);
    }
  }
  return overrides;
}

function createWorkspaceScopedHandler(params: {
  cfg: OpenClawConfig;
  handler: InternalHookHandler;
  workspaceDir: string;
}): InternalHookHandler {
  const targetWorkspaceDir = safeRealpathOrResolve(params.workspaceDir);
  return async (event) => {
    if (isGatewayStartupEvent(event)) {
      await params.handler({
        ...event,
        context: {
          ...event.context,
          workspaceDir: targetWorkspaceDir,
        },
      });
      return;
    }
    const eventWorkspaceDir = resolveEventWorkspaceDir(event, params.cfg);
    if (eventWorkspaceDir !== targetWorkspaceDir) {
      return;
    }
    await params.handler(event);
  };
}

function createSharedHookHandler(params: {
  cfg: OpenClawConfig;
  handler: InternalHookHandler;
  overriddenWorkspaces?: ReadonlyMap<string, ReadonlySet<string>>;
}): InternalHookHandler {
  if (!params.overriddenWorkspaces || params.overriddenWorkspaces.size === 0) {
    return params.handler;
  }

  return async (event) => {
    const eventWorkspaceDir = resolveEventWorkspaceDir(event, params.cfg);
    if (isGatewayStartupEvent(event)) {
      const hasStartupOverride = Array.from(params.overriddenWorkspaces.values()).some((events) =>
        events.has("gateway:startup"),
      );
      if (hasStartupOverride) {
        return;
      }
      await params.handler(event);
      return;
    }

    if (eventWorkspaceDir && params.overriddenWorkspaces?.has(eventWorkspaceDir)) {
      return;
    }
    await params.handler(event);
  };
}

function resolveEventWorkspaceDir(
  event: InternalHookEvent,
  cfg: OpenClawConfig,
): string | undefined {
  const context = event.context;
  const contextWorkspaceDir =
    typeof context.workspaceDir === "string" ? context.workspaceDir.trim() : "";
  if (contextWorkspaceDir) {
    return safeRealpathOrResolve(contextWorkspaceDir);
  }

  const contextAgentId = typeof context.agentId === "string" ? context.agentId.trim() : "";
  if (contextAgentId) {
    return safeRealpathOrResolve(resolveAgentWorkspaceDir(cfg, contextAgentId));
  }

  const sessionKey = event.sessionKey?.trim();
  if (!sessionKey || isGatewayStartupEvent(event)) {
    return undefined;
  }

  return safeRealpathOrResolve(
    resolveAgentWorkspaceDir(
      cfg,
      resolveSessionAgentId({
        sessionKey,
        config: cfg,
      }),
    ),
  );
}

function isGatewayStartupEvent(event: InternalHookEvent): boolean {
  return event.type === "gateway" && event.action === "startup";
}

function safeRealpathOrResolve(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}
