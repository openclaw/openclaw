import { createHash } from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { normalizeAgentId } from "../../routing/session-key.js";

export const SANDBOX_SUBAGENT_ATTACHMENTS_MOUNT = "/openclaw/attachments";

function resolveSubagentAttachmentRootDir(
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveStateDir(env), "attachments", "subagents", normalizeAgentId(agentId));
}

export function resolveSubagentSessionAttachmentRootDir(params: {
  agentId: string;
  childSessionKey: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const sessionRef = createHash("sha256").update(params.childSessionKey).digest("hex").slice(0, 32);
  return path.join(resolveSubagentAttachmentRootDir(params.agentId, params.env), sessionRef);
}

export function resolveSubagentAttachmentDir(params: {
  agentId: string;
  childSessionKey: string;
  attachmentId: string;
  env?: NodeJS.ProcessEnv;
}): string {
  return path.join(resolveSubagentSessionAttachmentRootDir(params), params.attachmentId);
}
