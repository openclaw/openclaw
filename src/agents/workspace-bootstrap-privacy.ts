/**
 * Session-aware bootstrap privacy: drop root MEMORY.md from shared/subagent/cron
 * contexts and apply the subagent/cron allowlists.
 */
import path from "node:path";
import type { ChatType } from "../channels/chat-type.js";
import { CANONICAL_ROOT_MEMORY_FILENAME } from "../memory/root-memory-files.js";
import { isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import { deriveSessionChatTypeFromKey } from "../sessions/session-chat-type-shared.js";
import { resolveUserPath } from "../utils.js";

// Leaf contract (structural copy of WorkspaceBootstrapFile) to avoid a
// workspace.ts <-> workspace-bootstrap-privacy.ts import cycle.
// Keep fields in sync with WorkspaceBootstrapFile in ./workspace.ts.
export type WorkspaceBootstrapPrivacyFile = {
  name: string;
  path: string;
  content?: string;
  missing: boolean;
};

const ROOT_MEMORY_ONLY = new Set([CANONICAL_ROOT_MEMORY_FILENAME]);
const SUBAGENT_BOOTSTRAP_ALLOWLIST = new Set(["AGENTS.md"]);
const CRON_BOOTSTRAP_ALLOWLIST = new Set(["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"]);

type BootstrapSessionContext = {
  sessionKey?: string;
  chatType?: ChatType;
  workspaceDir?: string;
};

function resolveBootstrapSessionContext(
  session?: string | BootstrapSessionContext,
): BootstrapSessionContext {
  return typeof session === "string" ? { sessionKey: session } : (session ?? {});
}

function filterRootMemoryBootstrapFiles<T extends WorkspaceBootstrapPrivacyFile>(
  files: T[],
  workspaceRoot?: string,
): T[] {
  if (!workspaceRoot) {
    return files.filter((file) => !ROOT_MEMORY_ONLY.has(file.name));
  }
  const resolvedWorkspaceRoot = resolveUserPath(workspaceRoot);
  const rootMemoryPaths = new Set(
    [...ROOT_MEMORY_ONLY].map((name) => path.join(resolvedWorkspaceRoot, name)),
  );
  return files.filter((file) => {
    if (typeof file.path !== "string") {
      return true;
    }
    const filePath = file.path.trim();
    if (!filePath) {
      return true;
    }
    const resolvedPath = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : filePath.startsWith("~")
        ? resolveUserPath(filePath)
        : path.resolve(resolvedWorkspaceRoot, filePath);
    return !rootMemoryPaths.has(resolvedPath);
  });
}

export function filterBootstrapFilesForSession<T extends WorkspaceBootstrapPrivacyFile>(
  files: T[],
  session?: string | BootstrapSessionContext,
): T[] {
  const { sessionKey, chatType, workspaceDir } = resolveBootstrapSessionContext(session);
  const isSubagent = isSubagentSessionKey(sessionKey);
  const isCron = isCronSessionKey(sessionKey);
  const effectiveChatType = chatType ?? deriveSessionChatTypeFromKey(sessionKey);
  const isSharedContext = effectiveChatType === "group" || effectiveChatType === "channel";
  const isNonPrivate = isSubagent || isCron || isSharedContext;
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
