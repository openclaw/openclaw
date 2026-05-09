import { getSessionEntry } from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { ReplyPayload } from "../types.js";
import type { HandleCommandsParams } from "./commands-types.js";

export interface ExportCommandSessionTarget {
  agentId: string;
  entry: SessionEntry;
}

const MAX_EXPORT_COMMAND_OUTPUT_PATH_CHARS = 512;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
): ExportCommandSessionTarget | ReplyPayload {
  const targetAgentId = params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey) ?? "main";
  const entry = getSessionEntry({
    agentId: targetAgentId,
    sessionKey: params.sessionKey,
  });
  if (!entry?.sessionId) {
    return { text: `❌ Session not found: ${params.sessionKey}` };
  }

  return { agentId: targetAgentId, entry };
}

export function isReplyPayload(
  value: ExportCommandSessionTarget | ReplyPayload,
): value is ReplyPayload {
  return "text" in value;
}
