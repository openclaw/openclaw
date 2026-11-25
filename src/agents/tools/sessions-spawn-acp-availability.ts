import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Why runtime="acp" cannot spawn from this session. */
export function resolveSessionsSpawnAcpUnavailableMessage(opts?: {
  sandboxed?: boolean;
  config?: OpenClawConfig;
}) {
  if (opts?.sandboxed === true) {
    return 'runtime="acp" is unavailable from sandboxed sessions because ACP sessions run on the host. Use runtime="subagent".';
  }
  if (opts?.config?.acp?.enabled === false) {
    return 'runtime="acp" is unavailable because ACP is disabled by policy (`acp.enabled=false`). Use runtime="subagent".';
  }
  return 'runtime="acp" is unavailable in this session because no ACP runtime backend is loaded. Enable the acpx plugin or use runtime="subagent".';
}
