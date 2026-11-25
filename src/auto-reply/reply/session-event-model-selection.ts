import { resolveAgentConfig } from "../../agents/agent-scope.js";
import type { PreparedReplyDispatchRuntime } from "../../agents/prepared-model-runtime.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveCronModelSelection,
  resolveCronModelSelectionOwner,
} from "../../cron/isolated-agent/model-selection.js";
import { resolveHookExternalContentSource } from "../../security/external-content-source.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { normalizeThinkLevel } from "../thinking.js";
import type { ScheduledSessionAutomation } from "./session-event-contract.js";

/** Resolve scheduled policy after session initialization, including queued config readmission. */
export async function resolveScheduledSessionModelSelection(params: {
  automation: ScheduledSessionAutomation;
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  sessionKey: string;
  sessionEntry: Pick<SessionEntry, "modelOverride" | "providerOverride">;
  publishedRuntime?: PreparedReplyDispatchRuntime;
}) {
  const payload = params.automation.job.payload;
  if (payload.kind !== "agentTurn") {
    return undefined;
  }
  const isGmailHook =
    (payload.externalContentSource ??
      resolveHookExternalContentSource(
        parseAgentSessionKey(params.sessionKey)?.rest ?? params.sessionKey,
      )) === "gmail";
  const owner = await resolveCronModelSelectionOwner({
    cfg: params.cfg,
    agentId: params.agentId,
    requiredAgentId: params.agentId,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    publishedRuntime: params.publishedRuntime,
  });
  const selection = await resolveCronModelSelection({
    ...params,
    owner,
    payloadModel: payload.model,
    isGmailHook,
    agentConfigOverride: resolveAgentConfig(params.cfg, params.agentId),
  });
  params.automation.assertCurrent();
  if (!selection.ok) {
    throw new Error(selection.error);
  }
  return {
    ...selection,
    thinkingLevelOverride:
      normalizeThinkLevel(payload.thinking) ??
      (isGmailHook ? normalizeThinkLevel(owner.config.hooks?.gmail?.thinking) : undefined),
  };
}
