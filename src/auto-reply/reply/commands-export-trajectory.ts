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
import { resolveHomeRelativePath } from "../../infra/home-dir.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  exportTrajectoryBundle,
  resolveDefaultTrajectoryExportDir,
} from "../../trajectory/export.js";
import { toTrajectoryToolDefinitions } from "../../trajectory/runtime.js";
import type { ReplyPayload } from "../types.js";
import { resolveCommandsSystemPromptBundle } from "./commands-system-prompt.js";
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
  env?: NodeJS.ProcessEnv;
  sessionId: string;
}): string {
  const raw = params.outputPath?.trim();
  if (!raw) {
    return resolveDefaultTrajectoryExportDir({
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
    });
  }
  return path.isAbsolute(raw) || raw.startsWith("~")
    ? resolveHomeRelativePath(raw, { env: params.env })
    : path.resolve(params.workspaceDir, raw);
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

  const { systemPrompt, tools } = await resolveCommandsSystemPromptBundle({
    ...params,
    sessionEntry: entry as HandleCommandsParams["sessionEntry"],
  });

  let outputDir: string;
  try {
    outputDir = resolveTrajectoryCommandOutputDir({
      outputPath: args.outputPath,
      workspaceDir: params.workspaceDir,
      sessionId: entry.sessionId,
      env: process.env,
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
      systemPrompt,
      tools: toTrajectoryToolDefinitions(tools),
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
