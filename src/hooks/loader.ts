import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { sanitizeForLog as safeLogValue } from "../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openRootFile } from "../infra/boundary-file-read.js";
import { safeRealpathSync } from "../infra/boundary-path.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  type InternalHookSelection,
  isHookLoadable,
  isHookNameSelected,
  resolveInternalHookSelection,
} from "./configured.js";
import { isKnownInternalHookEventKey } from "./internal-hook-types.js";
import {
  type InternalHookHandler,
  registerInternalHook,
  setInternalHooksEnabled,
  unregisterInternalHook,
} from "./internal-hooks.js";
import { resolveFunctionModuleExport } from "./module-loader.js";
import type { HookPolicyEntry, HookSource } from "./types.js";
import { prepareWorkspaceHookEntries, type HookSourceFact } from "./workspace.js";

function buildImportUrl(handlerPath: string, source: HookSource): string {
  const base = pathToFileURL(handlerPath).href;

  // Bundled hooks are immutable between installs; other sources may change between restarts.
  if (source === "openclaw-bundled") {
    return base;
  }

  // ctime detects same-size edits even when mtime is restored.
  try {
    const { ctimeMs, mtimeMs, size } = fs.statSync(handlerPath);
    return `${base}?t=${mtimeMs}&c=${ctimeMs}&s=${size}`;
  } catch {
    // Missing metadata still requires a fresh import.
    return `${base}?t=${Date.now()}`;
  }
}

const log = createSubsystemLogger("hooks:loader");

export type LoadHookHandlerModuleParams = {
  handlerPath: string;
  baseDir: string;
  source: HookSource;
  exportName?: string;
  /** When true, emit the trusted-local-code warning used by Gateway load. */
  warnTrustedLocal?: boolean;
};

export type LoadedHookHandlerModule = {
  handler: InternalHookHandler;
  exportName: string;
  resolvedPath: string;
};

/** Imports a hook handler module with the same boundary + export checks as Gateway load. */
export async function loadHookHandlerModule(
  params: LoadHookHandlerModuleParams,
): Promise<LoadedHookHandlerModule> {
  const hookBaseDir = safeRealpathSync(params.baseDir);
  if (!hookBaseDir) {
    throw new Error(`Hook base directory is no longer readable: ${params.baseDir}`);
  }
  const opened = await openRootFile({
    absolutePath: params.handlerPath,
    rootPath: hookBaseDir,
    boundaryLabel: "hook directory",
  });
  if (!opened.ok) {
    throw new Error(`Handler path fails boundary checks: ${params.handlerPath}`);
  }
  const safeHandlerPath = opened.path;
  fs.closeSync(opened.fd);
  if (
    params.warnTrustedLocal &&
    (params.source === "openclaw-workspace" || params.source === "openclaw-managed")
  ) {
    log.warn(
      `Loading ${params.source.slice("openclaw-".length)} hook code into the gateway process. Hooks are trusted local code.`,
    );
  }

  // Only mutable workspace/managed modules are cache-busted; imports may run trusted code.
  const mod = (await import(buildImportUrl(safeHandlerPath, params.source))) as Record<
    string,
    unknown
  >;
  const exportName = params.exportName?.trim() || "default";
  const handler = resolveFunctionModuleExport<InternalHookHandler>({ mod, exportName });
  if (!handler) {
    throw new Error(`Handler '${exportName}' is not a function`);
  }
  return { handler, exportName, resolvedPath: safeHandlerPath };
}

export type HookHandlerSmokeLoadResult = {
  loadOk: boolean;
  exportName: string;
  handlerPath: string;
  error?: string;
};

/**
 * Smoke-load a hook handler without registering it or mutating config.
 * Mirrors the Gateway import path used by `prepareInternalHooks`.
 */
export async function smokeLoadHookHandler(
  params: LoadHookHandlerModuleParams,
): Promise<HookHandlerSmokeLoadResult> {
  const exportName = params.exportName?.trim() || "default";
  try {
    // Diagnostics import disabled hooks; keep the trusted-local warning unless callers opt out.
    const loaded = await loadHookHandlerModule({
      ...params,
      warnTrustedLocal: params.warnTrustedLocal ?? true,
    });
    return {
      loadOk: true,
      exportName: loaded.exportName,
      handlerPath: loaded.resolvedPath,
    };
  } catch (error) {
    return {
      loadOk: false,
      exportName,
      handlerPath: params.handlerPath,
      error: formatErrorMessage(error),
    };
  }
}

// Configured hooks belong to the Gateway, not to any one plugin registry generation.
type HookGeneration = {
  registrations: Array<{ event: string; handler: InternalHookHandler }>;
  discovery?: { sources: HookSourceFact[]; declaredNames: Set<string> };
  committed?: true;
};
const hookOwner = resolveGlobalSingleton<{ generation: HookGeneration }>(
  Symbol.for("openclaw.loadedInternalHookRegistrations"),
  () => ({ generation: { registrations: [] } }),
  () => resetLoadedInternalHooks(),
);

function resetLoadedInternalHooks(): void {
  for (const { event, handler } of hookOwner.generation.registrations) {
    unregisterInternalHook(event, handler);
  }
  hookOwner.generation = { registrations: [] };
}

export type PreparedInternalHooks = {
  loadedCount: number;
  commit: (options?: { initial?: boolean }) => boolean;
};

/** Imports candidate handlers without publishing registrations or changing the dispatch gate. */
export async function prepareInternalHooks(
  cfg: OpenClawConfig,
  workspaceDir: string,
  opts?: {
    failureMode?: "atomic" | "best-effort";
    selection?: InternalHookSelection;
  },
): Promise<PreparedInternalHooks> {
  const enabled = cfg.hooks?.internal?.enabled !== false;
  const previousGeneration = hookOwner.generation;
  const registrations: HookGeneration["registrations"] = [];
  let loadedCount = 0;
  const selection = opts?.selection ?? (await resolveInternalHookSelection(cfg));
  const shouldLoadHook = (entry: HookPolicyEntry) =>
    isHookLoadable({ entry, config: cfg, names: selection.names });
  const discovery = selection.configured
    ? prepareWorkspaceHookEntries(workspaceDir, {
        config: cfg,
        ...(opts?.failureMode !== "best-effort"
          ? {
              requireValidHook: shouldLoadHook,
              previousSources: previousGeneration.discovery?.sources.filter(
                (entry) =>
                  !isHookNameSelected(previousGeneration.discovery?.declaredNames, entry) ||
                  isHookNameSelected(selection.declaredNames, entry),
              ),
            }
          : {}),
      })
    : { entries: [], sources: [] };

  for (const entry of discovery.entries) {
    if (!shouldLoadHook(entry)) {
      continue;
    }
    try {
      const { handler } = await loadHookHandlerModule({
        handlerPath: entry.hook.handlerPath,
        baseDir: entry.hook.baseDir,
        source: entry.hook.source,
        exportName: entry.metadata?.export,
        warnTrustedLocal: true,
      });
      const events = entry.metadata?.events ?? [];
      if (events.length === 0) {
        throw new Error("Hook has no events defined in metadata");
      }

      // Plugins can emit custom keys, so unknown core events remain advisory.
      const unknownEvents = events.filter((event) => !isKnownInternalHookEventKey(event));
      if (unknownEvents.length > 0) {
        log.warn(
          `Hook '${safeLogValue(entry.hook.name)}' subscribes to event${unknownEvents.length === 1 ? "" : "s"} ` +
            `${unknownEvents.map((event) => safeLogValue(event)).join(", ")} not emitted by OpenClaw core — ` +
            `likely a typo; unless a plugin emits it, the hook never fires. ` +
            `Known events: https://docs.openclaw.ai/automation/hooks`,
        );
      }
      registrations.push(...events.map((event) => ({ event, handler })));
      loadedCount++;
    } catch (error) {
      const message = `Failed to load hook ${safeLogValue(entry.hook.name)}: ${safeLogValue(formatErrorMessage(error))}`;
      if (opts?.failureMode !== "best-effort") {
        throw new Error(message, { cause: error });
      }
      log.error(message);
    }
  }

  return {
    loadedCount,
    commit({ initial = false } = {}) {
      // Deferred startup must not overwrite a reload, or a later Gateway lifecycle.
      if (
        initial &&
        (previousGeneration !== hookOwner.generation || previousGeneration.committed)
      ) {
        return false;
      }
      // Publish synchronously so events see one complete generation; keep unrelated listeners.
      resetLoadedInternalHooks();
      for (const { event, handler } of registrations) {
        registerInternalHook(event, handler);
      }
      hookOwner.generation = {
        registrations,
        discovery: { sources: discovery.sources, declaredNames: selection.declaredNames },
        committed: true,
      };
      setInternalHooksEnabled(enabled);
      return true;
    },
  };
}
