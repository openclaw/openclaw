import { resolveExecDefaultsAsync } from "../../agents/exec-defaults.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { maxAsk, minSecurity } from "../../infra/exec-approvals-policy.js";

/** Compare effective execution policy, including an inherited/default permission mode. */
export async function isParticipationPermissionTightening(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  before: SessionEntry | undefined;
  after: SessionEntry;
}): Promise<boolean> {
  const modes = ["read-only", "guarded", "workspace", "full"];
  const nextMode = params.after.permissionMode;
  if (
    !params.before ||
    !nextMode ||
    nextMode === "full" ||
    (params.before.permissionMode &&
      modes.indexOf(nextMode) > modes.indexOf(params.before.permissionMode))
  )
    return false;
  const [before, after] = await Promise.all([
    resolveExecDefaultsAsync({ ...params, sessionEntry: params.before }),
    resolveExecDefaultsAsync({ ...params, sessionEntry: params.after }),
  ]);
  const deniesMisses = before.security !== "full" && before.ask === "off";
  return (
    minSecurity(before.security, after.security) === after.security &&
    (after.security === "deny" ||
      (maxAsk(before.ask, after.ask) === after.ask &&
        !(deniesMisses && after.ask !== "off") &&
        !(before.mode === "ask" && after.mode === "auto")))
  );
}
