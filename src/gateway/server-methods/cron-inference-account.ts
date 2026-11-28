import { resolveAgentDir, tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope.js";
import {
  AuthProfileAuthorizationError,
  type AuthProfileAuthorization,
} from "../../agents/auth-profiles/authorization-contract.js";
import { captureAuthProfileAuthorization } from "../../agents/auth-profiles/authorization.js";
import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { resolveSimpleCompletionSelectionForAgent } from "../../agents/simple-completion-selection.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCronJobEffectiveAgentId } from "../../cron/agent-id.js";
import {
  acquireCronInferenceAuthorization,
  captureCronInferenceBinding,
} from "../../cron/inference-binding.runtime.js";
import { resolveCarriedCronModelSelection } from "../../cron/isolated-agent/session-carried-model.js";
import { resolveCronSessionTargetSessionKey } from "../../cron/session-target.js";
import type { CronJob, CronJobPatch, CronStoredJob } from "../../cron/types.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import type { UserModelAccountSelection } from "../model-account-authority.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "../session-utils-store-worker.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { preparePersonalModelAccountSelection } from "./users-model-account-access.js";

export type InferenceCaller = Pick<
  GatewayRequestHandlerOptions,
  "client" | "context" | "signal" | "hasCurrentClientAuthority"
> & {
  /** Native workflows may retain their authenticated requester without a creating conversation. */
  captureIndependentOperatorSource?: true;
};

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

/** Account edits replace ownership; a plain-model edit can release a deleted account onto a key. */
export async function captureCronUpdatedInferenceBinding(
  nextJob: CronStoredJob,
  patch: CronJobPatch,
  cfg: OpenClawConfig,
  caller: InferenceCaller,
) {
  const systemEventAccountEdit =
    nextJob.payload.kind === "systemEvent" &&
    patch.payload?.kind === "agentTurn" &&
    typeof patch.payload.model === "string";
  if (
    nextJob.runtimeAuthority !== undefined ||
    (nextJob.payload.kind !== "agentTurn" && !systemEventAccountEdit)
  ) {
    return undefined;
  }
  const model = patch.payload && "model" in patch.payload ? patch.payload.model : undefined;
  // The owner the job runs as. Cron's default is the ambient owner (configured system agent),
  // read from config because the lazy cron service has no default before it loads.
  const agentId = resolveCronJobEffectiveAgentId(nextJob, tryResolveAmbientOwnerAgentId(cfg));
  const selection = model
    ? resolveSimpleCompletionSelectionForAgent({ cfg, agentId, modelRef: model })
    : null;
  let recoverMissingAccount = false;
  if (
    model &&
    selection &&
    !selection.profileId &&
    nextJob.inferenceBinding &&
    patch.agentId === undefined
  ) {
    try {
      const authority = await captureAuthProfileAuthorization({
        profileId: nextJob.inferenceBinding.profileId,
        cfg,
        agentDir: resolveAgentDir(cfg, agentId),
        assertCurrent() {},
      });
      authority.dispose();
    } catch (error) {
      if (
        !(error instanceof AuthProfileAuthorizationError) ||
        error.code !== "MCP_AUTHORIZATION_RETIRED"
      ) {
        throw error;
      }
      recoverMissingAccount = true;
    }
  }
  // Capture validates the execution route before authorizing a clear; an empty
  // capture alone must never release an existing stored account.
  const cliExecution = selection
    ? resolveCliRuntimeExecutionProvider({
        cfg,
        agentId,
        provider: selection.provider,
        modelId: selection.modelId,
        authProfileId: selection.profileId,
      })
    : undefined;
  if (!model || !selection || (!selection.profileId && !recoverMissingAccount)) {
    if (systemEventAccountEdit) {
      throw new TypeError("Select a stored account for the main session’s current model.");
    }
    if (patch.agentId !== undefined && nextJob.inferenceBinding) {
      // A move may keep the account only when the new agent sees the same credential owner.
      const authority = await acquireCronInferenceAuthorization({
        binding: nextJob.inferenceBinding,
        cfg,
        agentDir: resolveAgentDir(cfg, agentId),
      });
      return {
        inferenceBinding: undefined,
        assertInferenceSelectionCurrent: () => authority.assertCurrent(),
        disposeInferenceAuthorization: () => authority.dispose(),
      };
    }
    return undefined;
  }
  // An account edit keeps the runtime the job records; otherwise it resolves the way create does.
  const recordedRuntime =
    recoverMissingAccount && selection.provider !== nextJob.inferenceBinding?.provider
      ? undefined
      : nextJob.inferenceBinding?.runtime;
  const executionKey = systemEventAccountEdit
    ? "main"
    : resolveCronSessionTargetSessionKey(nextJob.sessionTarget);
  const executionEntry = executionKey
    ? (await loadGatewaySessionEntryReadOnlyInWorker({ cfg, key: executionKey, agentId }))?.entry
    : undefined;
  if (systemEventAccountEdit) {
    const sessionModel = resolveSessionModelRef(cfg, executionEntry, agentId);
    if (
      executionEntry?.modelSelectionLocked ||
      sessionModel?.provider !== selection.provider ||
      sessionModel.model !== selection.modelId
    ) {
      throw new TypeError(
        "A system event uses its main session’s model. Select an account for that model, not a different model or runtime.",
      );
    }
  }
  const runtimeSessionEntry = await loadCronRuntimeSessionEntry({
    cfg,
    job: nextJob,
    agentId,
    executionEntry,
  });
  const inference = await captureCronInferenceForCaller(
    { cfg, agentId, model, runtimeSessionEntry, recordedRuntime },
    caller,
  );
  if (recoverMissingAccount) {
    if (inference.inferenceBinding === null) {
      return inference;
    }
    inference.disposeInferenceAuthorization();
    throw new Error(
      "Recover this automation with a model using a key in the environment or provider config, or select a stored account explicitly with model@profile.",
    );
  }
  if (
    systemEventAccountEdit &&
    (!inference.inferenceBinding || inference.inferenceBinding.profileId !== selection.profileId)
  ) {
    inference.disposeInferenceAuthorization();
    throw new TypeError("The selected stored account is unavailable for this system event.");
  }
  if (inference.inferenceBinding === undefined) {
    if (cliExecution && !nextJob.inferenceBinding) {
      return undefined;
    }
    throw new Error("The selected automation account is unavailable.");
  }
  // An account edit on the same provider never moves the job off the runtime it records;
  // when that runtime is no longer available, the edit fails and the binding stays as it was.
  const capturedRuntime =
    inference.inferenceBinding === null ? cliExecution : inference.inferenceBinding.runtime;
  if (
    recordedRuntime &&
    capturedRuntime !== recordedRuntime &&
    (inference.inferenceBinding?.provider ?? selection.provider) ===
      nextJob.inferenceBinding?.provider
  ) {
    inference.disposeInferenceAuthorization();
    throw new Error(
      `The automation runs on runtime ${recordedRuntime}, which is unavailable for this account; the edit would move it to runtime ${capturedRuntime ?? "unknown"}.`,
    );
  }
  return inference;
}
