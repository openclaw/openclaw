import { createHash } from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { normalizeAgentId } from "../../routing/session-key.js";

export const SANDBOX_SUBAGENT_ATTACHMENTS_MOUNT = "/openclaw/attachments";

export function resolveSubagentSessionAttachmentRootDir(params: {
  agentId: string;
  childSessionKey: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const sessionRef = createHash("sha256").update(params.childSessionKey).digest("hex").slice(0, 32);
  return path.join(
    resolveStateDir(params.env),
    "attachments",
    "subagents",
    normalizeAgentId(params.agentId),
    sessionRef,
  );
}

/** Resolves a per-session attachment root only when a run identity is available. */
export function subagentAttachmentRootForRun(
  agentId: string | undefined,
  childSessionKey: string | undefined,
): string | undefined {
  return agentId && childSessionKey
    ? resolveSubagentSessionAttachmentRootDir({ agentId, childSessionKey })
    : undefined;
}
