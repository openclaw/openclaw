import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { AuthProfileAuthorization } from "../agents/auth-profiles/authorization-contract.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureCronInferenceBinding } from "../cron/inference-binding.runtime.js";
import { resolveCarriedCronModelSelection } from "../cron/isolated-agent/session-carried-model.js";
import { resolveCronSessionTargetSessionKey } from "../cron/session-target.js";
import type { CronJob } from "../cron/types.js";
import { resolveHookExternalContentSource } from "../security/external-content-source.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { isUserModelAuthProfileId } from "../state/user-model-account-id.js";
import type { UserModelAccountSelection } from "./model-account-authority.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { preparePersonalModelAccountSelection } from "./server-methods/users-model-account-access.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";

export type InferenceCaller = Pick<GatewayRequestHandlerOptions, "client" | "context" | "signal">;

/**
 * The entry a job's cron session takes its runtime override from: the target row of a
 * `session:` job, or what a `current` job carries from its creating conversation.
 */
export async function loadCronRuntimeSessionEntry(params: {
  cfg: OpenClawConfig;
  job: Pick<CronJob, "sessionTarget" | "sessionKey">;
  agentId?: string;
  executionEntry?: SessionEntry;
  loaded?: { key: string; entry?: SessionEntry };
}): Promise<Partial<SessionEntry> | undefined> {
  if (params.executionEntry) {
    return params.executionEntry;
  }
  const sourceKey =
    params.job.sessionTarget === "current" ? params.job.sessionKey?.trim() : undefined;
  if (!sourceKey) {
    return undefined;
  }
  const source =
    params.loaded?.key === sourceKey
      ? params.loaded.entry
      : (
          await loadGatewaySessionEntryReadOnlyInWorker({
            cfg: params.cfg,
            key: sourceKey,
            agentId: params.agentId,
          })
        )?.entry;
  return source ? resolveCarriedCronModelSelection(source) : undefined;
}

export async function captureCronInferenceForCaller(
  params: Parameters<typeof captureCronInferenceBinding>[0],
  caller: InferenceCaller,
) {
  let selection: UserModelAccountSelection | undefined;
  let authority: AuthProfileAuthorization | undefined;
  const inferenceBinding = await captureCronInferenceBinding({
    ...params,
    retainAuthorization: (captured) => {
      authority = captured;
    },
    authorizeProfile: async (profileId, inherited) => {
      // Trusted creator selections already carry their owner's permission. New
      // personal selections require the same live human authority as chat.
      if (isUserModelAuthProfileId(profileId) && !inherited) {
        selection = await preparePersonalModelAccountSelection(caller, profileId);
        return selection.assertCurrent;
      }
      return undefined;
    },
  });
  return {
    inferenceBinding,
    assertInferenceSelectionCurrent: () => {
      selection?.assertCurrent();
      authority?.assertCurrent();
    },
    disposeInferenceAuthorization: () => authority?.dispose(),
  };
}

/** Capture the account for the actual scheduled target; creator attribution stays at ingress. */
export async function captureCronCreatedInference(params: {
  job: Pick<CronJob, "sessionTarget" | "sessionKey" | "payload">;
  cfg: OpenClawConfig;
  agentId?: string;
  sessionLookupAgentId?: string;
  caller: InferenceCaller;
  sessionEntry?: SessionEntry;
  loaded?: { key: string; entry?: SessionEntry };
}) {
  const { job, cfg, agentId, sessionLookupAgentId, caller, sessionEntry, loaded } = params;
  const executionSessionKey = resolveCronSessionTargetSessionKey(job.sessionTarget) ?? "";
  const executionSession =
    job.payload.kind === "agentTurn" && executionSessionKey
      ? await loadGatewaySessionEntryReadOnlyInWorker({
          cfg,
          key: executionSessionKey,
          agentId: sessionLookupAgentId,
        })
      : undefined;
  const runtimeSessionEntry =
    job.payload.kind === "agentTurn"
      ? await loadCronRuntimeSessionEntry({
          cfg,
          job,
          agentId: sessionLookupAgentId,
          executionEntry: executionSession?.entry,
          loaded,
        })
      : undefined;
  return job.payload.kind === "agentTurn" && job.sessionTarget !== "main"
    ? await captureCronInferenceForCaller(
        {
          cfg,
          agentId: agentId ?? resolveDefaultAgentId(cfg),
          model: job.payload.model,
          isGmailHook:
            (job.payload.externalContentSource ??
              resolveHookExternalContentSource(
                parseAgentSessionKey(executionSessionKey)?.rest ?? executionSessionKey,
              )) === "gmail",
          sessionEntry,
          executionSessionEntry: executionSession?.entry,
          runtimeSessionEntry,
        },
        caller,
      )
    : undefined;
}
