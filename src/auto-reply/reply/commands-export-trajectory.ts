import fs from "node:fs";
import path from "node:path";
import {
  resolveDefaultSessionStorePath,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../../config/sessions/paths.js";
import { loadSessionStore } from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  exportTrajectoryBundle,
  resolveDefaultTrajectoryExportDir,
} from "../../trajectory/export.js";
import type { ReplyPayload } from "../types.js";
import type { HandleCommandsParams } from "./commands-types.js";

function parseExportTrajectoryArgs(commandBodyNormalized: string): { outputPath?: string } {
  const normalized = commandBodyNormalized.trim();
  if (normalized === "/export-trajectory" || normalized === "/trajectory") {
    return {};
  }
  const args = normalized.replace(/^\/(export-trajectory|trajectory)\s*/, "").trim();
  const outputPath = args.split(/\s+/).find((part) => !part.startsWith("-"));
  return { outputPath };
}

function resolveTrajectoryCommandOutputDir(params: {
  outputPath?: string;
  workspaceDir: string;
  sessionId: string;
}): string {
  const raw = params.outputPath?.trim();
  if (!raw) {
    return resolveDefaultTrajectoryExportDir({
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
    });
  }
  if (path.isAbsolute(raw) || raw.startsWith("~")) {
    throw new Error("Output path must be relative to the workspace trajectory exports directory");
  }
  const baseDir = path.join(params.workspaceDir, ".openclaw", "trajectory-exports");
  const resolvedBase = path.resolve(baseDir);
  const outputDir = path.resolve(resolvedBase, raw);
  const relative = path.relative(resolvedBase, outputDir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Output path must stay inside the workspace trajectory exports directory");
  }
  return outputDir;
}

export async function buildExportTrajectoryReply(
  params: HandleCommandsParams,
): Promise<ReplyPayload> {
  const args = parseExportTrajectoryArgs(params.command.commandBodyNormalized);
  const targetAgentId = resolveAgentIdFromSessionKey(params.sessionKey) || params.agentId;
  const storePath = params.storePath ?? resolveDefaultSessionStorePath(targetAgentId);
  const store = loadSessionStore(storePath, { skipCache: true });
  const entry = store[params.sessionKey] as SessionEntry | undefined;
  if (!entry?.sessionId) {
    return { text: `❌ Session not found: ${params.sessionKey}` };
  }

  let sessionFile: string;
  try {
    sessionFile = resolveSessionFilePath(
      entry.sessionId,
      entry,
      resolveSessionFilePathOptions({ agentId: targetAgentId, storePath }),
    );
  } catch (err) {
    return {
      text: `❌ Failed to resolve session file: ${formatErrorMessage(err)}`,
    };
  }
  if (!fs.existsSync(sessionFile)) {
    return { text: `❌ Session file not found: ${sessionFile}` };
  }

  let outputDir: string;
  try {
    outputDir = resolveTrajectoryCommandOutputDir({
      outputPath: args.outputPath,
      workspaceDir: params.workspaceDir,
      sessionId: entry.sessionId,
    });
  } catch (err) {
    return {
      text: `❌ Failed to resolve output path: ${formatErrorMessage(err)}`,
    };
  }

  let bundle: ReturnType<typeof exportTrajectoryBundle>;
  try {
    bundle = exportTrajectoryBundle({
      outputDir,
      sessionFile,
      sessionId: entry.sessionId,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
    });
  } catch (err) {
    return {
      text: `❌ Failed to export trajectory: ${formatErrorMessage(err)}`,
    };
  }

  const relativePath = path.relative(params.workspaceDir, bundle.outputDir);
  const displayPath = relativePath.startsWith("..") ? bundle.outputDir : relativePath;
  const files = ["manifest.json", "events.jsonl", "session.jsonl"];
  if (bundle.runtimeFile) {
    files.push("runtime.jsonl");
  }
  if (bundle.events.some((event) => event.type === "context.compiled")) {
    files.push("system-prompt.txt", "tools.json");
  }
  files.push(...bundle.supplementalFiles);

  return {
    text: [
      "✅ Trajectory exported!",
      "",
      `📦 Bundle: ${displayPath}`,
      `🧵 Session: ${entry.sessionId}`,
      `📊 Events: ${bundle.manifest.eventCount}`,
      `🧪 Runtime events: ${bundle.manifest.runtimeEventCount}`,
      `📝 Transcript events: ${bundle.manifest.transcriptEventCount}`,
      `📁 Files: ${files.join(", ")}`,
    ].join("\n"),
  };
}
