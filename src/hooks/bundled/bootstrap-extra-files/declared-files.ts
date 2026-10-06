// The bundled handler and diagnostics read the same declared extra files.
import { resolveExtraBootstrapPatterns } from "../../../agents/workspace-bootstrap-policy.js";
import { loadExtraBootstrapFilesWithDiagnostics } from "../../../agents/workspace.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
/** Loads the extra bootstrap files the hook config declares for a workspace. */
export async function loadDeclaredExtraBootstrapFiles(params: {
  config: OpenClawConfig | undefined;
  workspaceDir: string;
}): ReturnType<typeof loadExtraBootstrapFilesWithDiagnostics> {
  const patterns = resolveExtraBootstrapPatterns(params.config);
  if (patterns.length === 0) {
    return { files: [], diagnostics: [] };
  }
  return loadExtraBootstrapFilesWithDiagnostics(params.workspaceDir, patterns);
}
