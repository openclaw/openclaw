import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { escapeRegExp } from "../../shared/regexp.js";
import type { HandleCommandsParams } from "./commands-types.js";

interface ExportCommandSessionTarget {
  agentId: string;
  entry: SessionEntry;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}

const MAX_EXPORT_COMMAND_OUTPUT_PATH_CHARS = 512;

export function parseExportCommandOutputPath(
  commandBodyNormalized: string,
  aliases: readonly string[],
): { outputPath?: string; error?: string } {
  const normalized = commandBodyNormalized.trim();
  if (aliases.some((alias) => normalized === `/${alias}`)) {
    return {};
  }
  const aliasPattern = aliases.map(escapeRegExp).join("|");
  const args = normalized.replace(new RegExp(`^/(${aliasPattern})\\s*`), "").trim();
  const outputPath = args.split(/\s+/).find((part) => !part.startsWith("-"));
  if (outputPath && outputPath.length > MAX_EXPORT_COMMAND_OUTPUT_PATH_CHARS) {
    return {
      error: `❌ Output path is too long. Keep it at ${MAX_EXPORT_COMMAND_OUTPUT_PATH_CHARS} characters or less.`,
    };
  }
  return { outputPath };
}

export function resolveExportCommandSessionTarget(
  params: HandleCommandsParams,
): ExportCommandSessionTarget | { text: string } {
  const targetAgentId = params.agentId;
  const storePath = params.storePath ?? resolveDefaultSessionStorePath(targetAgentId);
  const entry = loadSessionEntryReadOnly({
    storePath,
    sessionKey: params.sessionKey,
    clone: false,
  });
  const sessionId = entry?.sessionId;
  if (!sessionId) {
    return { text: `❌ Session not found: ${params.sessionKey}` };
  }

  return {
    agentId: targetAgentId,
    entry,
    sessionId,
    sessionKey: params.sessionKey,
    storePath,
  };
}
