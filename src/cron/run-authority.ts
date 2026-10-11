import type { AdmittedRunContext } from "../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronAgentSessionKey } from "./isolated-agent/session-key.js";
import type { CronStoredJob } from "./types.js";

/** Scheduler-owned provenance determines authority, independently of the selected runner. */
export function resolveCronRunAdmissionSource(
  job: CronStoredJob,
): NonNullable<AdmittedRunContext["admissionSource"]> {
  return job.owner?.sessionKey ||
    job.owner?.accountId ||
    job.scheduledToolPolicy?.mode === "account" ||
    (job.payload.kind === "agentTurn" && job.payload.externalContentSource) ||
    job.toolsAllowProvenance?.channelRequester ||
    (job.toolsAllowProvenance && job.toolsAllowProvenance.callerOrigin?.kind !== "local")
    ? "requester-schedule"
    : "operator-schedule";
}

/** A scheduled requester cannot acquire another conversation's filesystem binding. */
export function resolveCronSessionWorkspaceOwnershipError(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  ownerSessionKey: string | undefined;
  hasWorkspaceBinding: boolean;
  admissionSource: NonNullable<AdmittedRunContext["admissionSource"]>;
}): string | undefined {
  if (!params.hasWorkspaceBinding || params.admissionSource !== "requester-schedule") {
    return undefined;
  }
  const ownerSessionKey = params.ownerSessionKey?.trim();
  if (
    !ownerSessionKey ||
    resolveCronAgentSessionKey({
      sessionKey: ownerSessionKey,
      agentId: params.agentId,
      cfg: params.cfg,
      mainKey: params.cfg.session?.mainKey,
    }) !== params.sessionKey
  ) {
    return "Requester-scoped automation can only use its owning conversation’s workspace.";
  }
  return undefined;
}
