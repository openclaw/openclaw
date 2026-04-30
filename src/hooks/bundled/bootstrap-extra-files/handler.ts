import {
  filterBootstrapFilesForSession,
  loadExtraBootstrapFilesWithDiagnostics,
} from "../../../agents/workspace.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { normalizeTrimmedStringList } from "../../../shared/string-normalization.js";
import { resolveHookConfig } from "../../config.js";
import { isAgentBootstrapEvent, type HookHandler } from "../../hooks.js";

const HOOK_KEY = "bootstrap-extra-files";
const log = createSubsystemLogger("bootstrap-extra-files");

function resolveExtraBootstrapPatterns(hookConfig: Record<string, unknown>): string[] {
  const fromPaths = normalizeTrimmedStringList(hookConfig.paths);
  if (fromPaths.length > 0) {
    return fromPaths;
  }
  const fromPatterns = normalizeTrimmedStringList(hookConfig.patterns);
  if (fromPatterns.length > 0) {
    return fromPatterns;
  }
  return normalizeTrimmedStringList(hookConfig.files);
}

function resolveSessionBootstrapPatterns(
  hookConfig: Record<string, unknown>,
  sessionKey?: string,
): string[] {
  if (!sessionKey) {
    return [];
  }
  const sessions = hookConfig.sessions;
  if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) {
    return [];
  }
  return normalizeTrimmedStringList((sessions as Record<string, unknown>)[sessionKey]);
}

const bootstrapExtraFilesHook: HookHandler = async (event) => {
  if (!isAgentBootstrapEvent(event)) {
    return;
  }

  const context = event.context;
  const hookConfig = resolveHookConfig(context.cfg, HOOK_KEY);
  if (!hookConfig || hookConfig.enabled === false) {
    return;
  }

  const typedConfig = hookConfig as Record<string, unknown>;
  const globalPatterns = resolveExtraBootstrapPatterns(typedConfig);
  const sessionPatterns = resolveSessionBootstrapPatterns(typedConfig, context.sessionKey);
  if (globalPatterns.length === 0 && sessionPatterns.length === 0) {
    return;
  }

  try {
    const globalResult = await loadExtraBootstrapFilesWithDiagnostics(
      context.workspaceDir,
      globalPatterns,
    );
    const sessionResult = await loadExtraBootstrapFilesWithDiagnostics(
      context.workspaceDir,
      sessionPatterns,
      { allowArbitraryBasenames: true },
    );
    const seenExtraPaths = new Set<string>();
    const extras = [...globalResult.files, ...sessionResult.files].filter((file) => {
      if (seenExtraPaths.has(file.path)) {
        return false;
      }
      seenExtraPaths.add(file.path);
      return true;
    });
    const diagnostics = [...globalResult.diagnostics, ...sessionResult.diagnostics];
    if (diagnostics.length > 0) {
      log.debug("skipped extra bootstrap candidates", {
        skipped: diagnostics.length,
        reasons: diagnostics.reduce<Record<string, number>>((counts, item) => {
          counts[item.reason] = (counts[item.reason] ?? 0) + 1;
          return counts;
        }, {}),
      });
    }
    if (extras.length === 0) {
      return;
    }
    context.bootstrapFiles = filterBootstrapFilesForSession(
      [...context.bootstrapFiles, ...extras],
      context.sessionKey,
    );
  } catch (err) {
    log.warn(`failed: ${String(err)}`);
  }
};

export default bootstrapExtraFilesHook;
