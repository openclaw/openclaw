import {
  AuthProfileAuthorizationError,
  type AuthProfileAuthorization,
} from "../agents/auth-profiles/authorization-contract.js";
import { captureAuthProfileAuthorization } from "../agents/auth-profiles/authorization.js";
import { resolveSessionAuthSelection } from "../agents/auth-profiles/session-override.js";
import { ensureAuthProfileStoreAsync } from "../agents/auth-profiles/store-runtime.js";
import { resolveAgentHarnessSelectionDecision } from "../agents/harness/selection-decision.js";
import { resolveProviderModelAuthPolicy } from "../agents/model-auth-policy.js";
import { resolveCliRuntimeExecutionProvider } from "../agents/model-runtime-aliases.js";
import { isConfiguredKeyAuthSource } from "../agents/provider-model-auth-source-plan.js";
import { prepareAgentRuntimeAuth } from "../agents/runtime-plan/prepare-auth.js";
import { resolveSimpleCompletionSelectionForAgent } from "../agents/simple-completion-selection.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { workerInferencePlacement } from "../gateway/worker-environments/inference-placement.js";
import type { CronInferenceBinding } from "./inference-binding.js";

/** Capture only a selected, current credential owner; never infer a legacy job's history. */
export async function captureCronInferenceBinding(params: {
  cfg: OpenClawConfig;
  agentId: string;
  model?: string;
  sessionEntry?: SessionEntry;
  authorizeProfile?: (profileId: string, inherited: boolean) => Promise<(() => void) | undefined>;
  retainAuthorization?: (authority: AuthProfileAuthorization) => void;
}): Promise<CronInferenceBinding | undefined> {
  const { cfg, agentId } = params;
  const model = resolveSimpleCompletionSelectionForAgent({ cfg, agentId, modelRef: params.model });
  if (!model) {
    throw new Error("Automation model could not be resolved.");
  }
  // CLI backends own their login; a host profile cannot bind that account.
  if (
    resolveCliRuntimeExecutionProvider({
      cfg,
      agentId,
      provider: model.provider,
      modelId: model.modelId,
    })
  ) {
    return undefined;
  }
  // A temporary creator model does not change the model an unpinned job will run.
  const creatorProvider =
    params.sessionEntry?.providerOverride ?? params.sessionEntry?.modelProvider;
  const creatorSession =
    creatorProvider && creatorProvider !== model.provider ? undefined : params.sessionEntry;
  const { agentDir } = model;
  let selection = await resolveSessionAuthSelection({
    cfg,
    agentId,
    agentDir,
    provider: model.provider,
    modelId: model.modelId,
    configuredProfileId: model.profileId ?? creatorSession?.authProfileOverride,
    sessionEntry: model.profileId ? undefined : creatorSession,
    isNewSession: false,
  });
  const requiredProfileId = cfg.cloudWorkers?.requiredProfile;
  const requiredProfile = requiredProfileId
    ? cfg.cloudWorkers?.profiles?.[requiredProfileId]
    : undefined;
  if (
    !selection &&
    requiredProfile &&
    workerInferencePlacement({
      providerId: requiredProfile.provider,
      profileSnapshot: requiredProfile,
    }) === "worker"
  ) {
    // Required worker inference owns its credentials; do not capture an ambient host account.
    return undefined;
  }
  const store = await ensureAuthProfileStoreAsync(agentDir, {
    profileId: selection?.profileId,
    allowKeychainPrompt: false,
    config: cfg,
  });
  if (!selection) {
    // With no compatible creator account, use the same route-aware planner as a fresh run.
    const harness = resolveAgentHarnessSelectionDecision({
      provider: model.provider,
      modelId: model.modelId,
      config: cfg,
      agentId,
    });
    const [attempt] = prepareAgentRuntimeAuth({
      provider: model.provider,
      modelId: model.modelId,
      config: cfg,
      agentId,
      agentDir,
      authProfileStore: store,
      harnessId: harness.selectedHarnessId,
      harnessRuntime: harness.selectedHarnessId,
      harnessAuthBootstrap: harness.harness?.authBootstrap,
    }).attempts;
    if (attempt?.kind !== "profile") {
      // A configured key keeps the job unbound, the same rule its runs follow.
      const source = attempt?.plan.credentialSource;
      if (source?.kind === "direct" && !isConfiguredKeyAuthSource(source)) {
        throw new Error(
          "Automation requires a stored inference account or a key in the environment or provider config. Select an account with model@profile.",
        );
      }
      return undefined;
    }
    selection = {
      profileId: attempt.profileId,
      source: attempt.plan.forwardedAuthProfileSource ?? "auto",
      routeRequirement: attempt.plan.modelRoute?.authRequirement,
    };
  }
  const assertSelectionCurrent = await params.authorizeProfile?.(
    selection.profileId,
    !model.profileId && selection.profileId === creatorSession?.authProfileOverride,
  );
  const credential = store.profiles[selection.profileId];
  if (!credential) {
    throw new Error("Automation requires an available stored inference account.");
  }
  const authRequirement =
    selection.routeRequirement ??
    resolveProviderModelAuthPolicy({
      provider: model.provider,
      mode: credential.type,
      authFlow: credential.type === "oauth" ? credential.authFlow : undefined,
    }).authRequirement;
  if (!authRequirement) {
    throw new Error("Automation requires a supported stored inference authentication route.");
  }
  const authority = await captureAuthProfileAuthorization({
    profileId: selection.profileId,
    agentDir,
    cfg,
    assertCurrent: assertSelectionCurrent ?? (() => {}),
  });
  let retained = false;
  try {
    authority.assertCurrent();
    params.retainAuthorization?.(authority);
    retained = params.retainAuthorization !== undefined;
    return {
      version: 1,
      provider: model.provider,
      profileId: selection.profileId,
      authorizationId: authority.authorizationId,
      authRequirement,
      source:
        model.profileId ||
        creatorSession?.authProfileOverrideSource === "user" ||
        creatorSession?.authProfileOverrideSource === "user-link" ||
        (!creatorSession?.authProfileOverride && selection.source === "user")
          ? "user"
          : "auto",
    };
  } finally {
    if (!retained) {
      authority.dispose();
    }
  }
}

/** Reacquire the same owner, including its live revocation and replacement checks. */
export async function acquireCronInferenceAuthorization(params: {
  binding: CronInferenceBinding;
  cfg: OpenClawConfig;
  agentDir: string;
}) {
  let authority: AuthProfileAuthorization | undefined;
  try {
    authority = await captureAuthProfileAuthorization({
      profileId: params.binding.profileId,
      agentDir: params.agentDir,
      cfg: params.cfg,
      assertCurrent() {},
    });
    if (authority.authorizationId !== params.binding.authorizationId) {
      throw new Error(
        "Automation inference account was replaced. Explicitly select an authorized account again.",
      );
    }
    authority.assertCurrent();
    return authority;
  } catch (error) {
    authority?.dispose();
    // The shared authorization owner names its retired error for MCP callers; say what an
    // automation lost instead.
    if (
      error instanceof AuthProfileAuthorizationError &&
      error.code === "MCP_AUTHORIZATION_RETIRED"
    ) {
      throw new Error(
        `Automation inference account ${params.binding.profileId} was removed or signed out. Explicitly select an authorized account again.`,
        { cause: error },
      );
    }
    throw error;
  }
}
