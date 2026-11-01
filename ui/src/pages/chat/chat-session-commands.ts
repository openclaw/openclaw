import type { ChatMetadataResult } from "../../lib/chat/chat-metadata-cache.ts";
import {
  applyRemoteSlashCommandsResult,
  invalidateSessionSlashCommands,
  refreshSlashCommands,
} from "../../lib/chat/slash-command-catalog.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";

/**
 * Execution-root facts of the selected session (managed worktree or spawned cwd), the
 * same inputs the Gateway uses to admit that session's project skills.
 */
function resolveSessionSkillScope(host: ChatPageHost): string | undefined {
  const row = selectedChatSessionRow(host);
  return row && (row.worktree || row.spawnedCwd)
    ? JSON.stringify([row.worktree?.id ?? null, row.spawnedCwd ?? null])
    : undefined;
}

export async function refreshChatCommands(host: ChatPageHost) {
  return refreshSlashCommands({
    client: host.client,
    agentId: resolveChatAgentId(host),
    sessionKey: host.sessionKey,
    sessionSkillScope: resolveSessionSkillScope(host),
  });
}

/** Agent-scoped metadata commands stand in only for sessions without a project root. */
export function applyChatMetadataCommands(host: ChatPageHost, result: ChatMetadataResult) {
  if (!resolveSessionSkillScope(host) || !host.client) {
    applyRemoteSlashCommandsResult(result);
    return;
  }
  // A republished agent catalog (config or skill change) also retires the session's copy.
  invalidateSessionSlashCommands(host.client, {
    agentId: resolveChatAgentId(host) ?? undefined,
    sessionKey: host.sessionKey,
  });
  void refreshChatCommands(host);
}
