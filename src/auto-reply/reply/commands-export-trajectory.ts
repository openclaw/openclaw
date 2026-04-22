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

  const outputDir = args.outputPath
    ? path.resolve(
        args.outputPath.startsWith("~")
          ? args.outputPath.replace("~", process.env.HOME ?? "")
          : args.outputPath,
      )
    : resolveDefaultTrajectoryExportDir({
        workspaceDir: params.workspaceDir,
        sessionId: entry.sessionId,
      });

  const bundle = exportTrajectoryBundle({
    outputDir,
    sessionFile,
    sessionId: entry.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    systemPrompt,
    tools: toTrajectoryToolDefinitions(tools),
  });

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
