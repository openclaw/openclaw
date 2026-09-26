// Trajectory command export helpers implement CLI export behavior.
import fsp from "node:fs/promises";
import path from "node:path";
import { pathScope } from "@openclaw/fs-safe/advanced";
import type { SessionTranscriptRuntimeTarget } from "../config/sessions/session-accessor.js";
import { root } from "../infra/fs-safe.js";
import { exportTrajectoryBundle, resolveDefaultTrajectoryExportDir } from "./export.js";

// CLI-facing trajectory export wrapper: resolves safe workspace-local paths,
// writes the diagnostic bundle, and formats the terse success summary.
export type TrajectoryCommandExportSummary = {
  outputDir: string;
  displayPath: string;
  sessionId: string;
  eventCount: number;
  runtimeEventCount: number;
  transcriptEventCount: number;
  files: string[];
};

async function resolveTrajectoryExportBaseDir(workspaceDir: string): Promise<{
  baseDir: string;
  realBase: string;
}> {
  const workspacePath = path.resolve(workspaceDir);
  const realWorkspace = await fsp.realpath(workspacePath);
  const relative = path.join(".openclaw", "trajectory-exports");
  const prepared = await pathScope(realWorkspace, { label: "workspace" }).ensureDir(relative, {
    mode: 0o700,
  });
  if (!prepared.ok) {
    throw prepared.diagnostic ?? new Error(prepared.error);
  }
  return { baseDir: path.join(workspacePath, relative), realBase: prepared.path };
}

async function resolveTrajectoryCommandOutputDir(params: {
  outputPath?: string;
  workspaceDir: string;
  sessionId: string;
}): Promise<string> {
  const { baseDir, realBase } = await resolveTrajectoryExportBaseDir(params.workspaceDir);
  const raw = params.outputPath?.trim();
  if (!raw) {
    const defaultDir = resolveDefaultTrajectoryExportDir({
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
    });
    return path.join(baseDir, path.basename(defaultDir));
  }
  if (path.isAbsolute(raw) || raw.startsWith("~")) {
    throw new Error("Output path must be relative to the workspace trajectory exports directory");
  }
  const resolvedBase = path.resolve(baseDir);
  const outputDir = path.resolve(resolvedBase, raw);
  const relative = path.relative(resolvedBase, outputDir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Output path must stay inside the workspace trajectory exports directory");
  }
  // Prefix with `./` so normalized literal `~/...` names do not expand to HOME.
  await (await root(realBase)).resolve(`.${path.sep}${relative}`);
  return outputDir;
}

export async function exportTrajectoryForCommand(params: {
  outputDir?: string;
  outputPath?: string;
  sessionFile?: string;
  sessionTarget?: SessionTranscriptRuntimeTarget;
  sessionId: string;
  sessionKey: string;
  workspaceDir: string;
}): Promise<TrajectoryCommandExportSummary> {
  const outputDir =
    params.outputDir ??
    (await resolveTrajectoryCommandOutputDir({
      outputPath: params.outputPath,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
    }));
  const bundle = await exportTrajectoryBundle({
    outputDir,
    sessionFile: params.sessionFile,
    sessionTarget: params.sessionTarget,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
  });
  const relativePath = path.relative(params.workspaceDir, bundle.outputDir);
  const displayPath =
    relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
      ? relativePath
      : path.basename(bundle.outputDir);
  return {
    outputDir: bundle.outputDir,
    displayPath,
    sessionId: params.sessionId,
    eventCount: bundle.manifest.eventCount,
    runtimeEventCount: bundle.manifest.runtimeEventCount,
    transcriptEventCount: bundle.manifest.transcriptEventCount,
    files: [
      ...bundle.files.filter((file) => !bundle.supplementalFiles.includes(file)),
      ...bundle.supplementalFiles,
    ],
  };
}

// Human CLI output contract. Keep this stable for docs/tests that snapshot the
// command text, but keep raw paths in the structured summary above.
export function formatTrajectoryCommandExportSummary(
  summary: TrajectoryCommandExportSummary,
): string {
  return [
    "✅ Trajectory exported!",
    "",
    `📦 Bundle: ${summary.displayPath}`,
    `🧵 Session: ${summary.sessionId}`,
    `📊 Events: ${summary.eventCount}`,
    `🧪 Runtime events: ${summary.runtimeEventCount}`,
    `📝 Transcript events: ${summary.transcriptEventCount}`,
    `📁 Files: ${summary.files.join(", ")}`,
  ].join("\n");
}
