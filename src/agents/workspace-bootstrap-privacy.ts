/**
 * Session-aware bootstrap privacy: drop root MEMORY.md from shared/subagent/cron
 * contexts and apply the subagent/cron allowlists.
 */
import path from "node:path";
import type { ChatType } from "../channels/chat-type.js";
import { isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import { deriveSessionChatTypeFromKey } from "../sessions/session-chat-type-shared.js";
import { resolveUserPath } from "../utils.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_USER_FILENAME,
  resolveWorkspaceBootstrapPath,
  type WorkspaceBootstrapFile,
} from "./workspace-bootstrap-policy.js";

const SUBAGENT_BOOTSTRAP_ALLOWLIST = new Set([DEFAULT_AGENTS_FILENAME]);
const CRON_BOOTSTRAP_ALLOWLIST = new Set([
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
]);

type BootstrapSessionContext = {
  sessionKey?: string;
  chatType?: ChatType;
  workspaceDir?: string;
};

function filterRootMemoryBootstrapFiles(
  files: WorkspaceBootstrapFile[],
  workspaceRoot?: string,
): WorkspaceBootstrapFile[] {
  if (!workspaceRoot) {
    return files.filter((file) => file.name !== DEFAULT_MEMORY_FILENAME);
  }
  const resolvedWorkspaceRoot = resolveUserPath(workspaceRoot);
  const rootMemoryPath = path.join(resolvedWorkspaceRoot, DEFAULT_MEMORY_FILENAME);
  return files.filter((file) => {
    if (typeof file.path !== "string") {
      return true;
    }
    const filePath = file.path.trim();
    if (!filePath) {
      return true;
    }
    const resolvedPath = resolveWorkspaceBootstrapPath(resolvedWorkspaceRoot, filePath);
    return resolvedPath !== rootMemoryPath;
  });
}

export function filterBootstrapFilesForSession(
  files: WorkspaceBootstrapFile[],
  session?: string | BootstrapSessionContext,
): WorkspaceBootstrapFile[] {
  const { sessionKey, chatType, workspaceDir }: BootstrapSessionContext =
    typeof session === "string" ? { sessionKey: session } : (session ?? {});
  const isSubagent = isSubagentSessionKey(sessionKey);
  const isCron = isCronSessionKey(sessionKey);
  const effectiveChatType = chatType ?? deriveSessionChatTypeFromKey(sessionKey);
  const isNonPrivate =
    isSubagent || isCron || effectiveChatType === "group" || effectiveChatType === "channel";
  const privacyFilteredFiles = isNonPrivate
    ? filterRootMemoryBootstrapFiles(files, workspaceDir)
    : files;
  if (isSubagent) {
    return privacyFilteredFiles.filter((file) => SUBAGENT_BOOTSTRAP_ALLOWLIST.has(file.name));
  }
  if (isCron) {
    return privacyFilteredFiles.filter((file) => CRON_BOOTSTRAP_ALLOWLIST.has(file.name));
  }
  return privacyFilteredFiles;
}
