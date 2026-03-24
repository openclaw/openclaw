import type { OpenClawConfig } from "../../config/config.js";
import { buildWorkspaceHookSnapshot } from "../../hooks/workspace.js";

function resolveConfiguredBootstrapExtraFilesPatterns(cfg?: OpenClawConfig): string[] {
  const entry = cfg?.hooks?.internal?.entries?.["bootstrap-extra-files"];
  if (!entry || typeof entry !== "object") {
    return [];
  }

  const values = [
    ...(Array.isArray(entry.paths) ? entry.paths : []),
    ...(Array.isArray(entry.patterns) ? entry.patterns : []),
    ...(Array.isArray(entry.files) ? entry.files : []),
  ];
  return values.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean);
}

export function hasPromptAffectingBootstrapHooks(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
}): boolean {
  if (!params.cfg?.hooks?.internal?.enabled) {
    return false;
  }

  const snapshot = buildWorkspaceHookSnapshot(params.workspaceDir, {
    config: params.cfg,
  });
  return snapshot.hooks.some((hook, index) => {
    if (!hook.events.includes("agent:bootstrap")) {
      return false;
    }

    const resolvedHook = snapshot.resolvedHooks?.[index];
    // The bundled extra-files hook is default-on, but without configured patterns
    // it exits immediately and does not change bootstrap context.
    if (
      resolvedHook?.source === "openclaw-bundled" &&
      resolvedHook.name === "bootstrap-extra-files"
    ) {
      return resolveConfiguredBootstrapExtraFilesPatterns(params.cfg).length > 0;
    }
    return true;
  });
}
