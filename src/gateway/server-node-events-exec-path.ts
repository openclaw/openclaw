import { withNodePathPrependWarning } from "../agents/exec-node-path-prepend.js";
import { resolveExecToolConfig } from "../agents/lazy-exec-tool.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePathPrepend } from "../infra/path-prepend.js";

/** Node-reported exec results never received tools.exec.pathPrepend; say so beside the outcome. */
export function withNodeExecPathPrependWarning(text: string, cfg: OpenClawConfig, agentId: string) {
  const configured = resolveExecToolConfig({ cfg, agentId }).configuredPathPrepend;
  return withNodePathPrependWarning(text, normalizePathPrepend(configured).length > 0);
}
