import { resolveAgentConfig } from "../agents/agent-scope.js";
import {
  AuthProfileAuthorizationError,
  type AuthProfileAuthorization,
} from "../agents/auth-profiles/authorization-contract.js";
import { captureAuthProfileAuthorization } from "../agents/auth-profiles/authorization.js";
import { resolveSessionAuthSelection } from "../agents/auth-profiles/session-override.js";
import { ensureAuthProfileStoreAsync } from "../agents/auth-profiles/store-runtime.js";
import {
  cliBackendAcceptsAuthProfileForwarding,
  resolveCliExecutionAuthProfileId,
} from "../agents/cli-execution-auth.js";
import { resolveAgentHarnessSelectionDecision } from "../agents/harness/selection-decision.js";
import { resolveProviderModelAuthPolicy } from "../agents/model-auth-policy.js";
import { resolveCliRuntimeExecutionProvider } from "../agents/model-runtime-aliases.js";
import { isConfiguredKeyAuthSource } from "../agents/provider-model-auth-source-plan.js";
import { prepareAgentRuntimeAuth } from "../agents/runtime-plan/prepare-auth.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { workerInferencePlacement } from "../gateway/worker-environments/inference-placement.js";
import type { CronInferenceBinding } from "./inference-binding.js";
import {
  resolveCronModelSelection,
  resolveCronModelSelectionOwner,
} from "./isolated-agent/model-selection.js";

/** Capture only a selected, current credential owner; never infer a legacy job's history. */
export async function captureCronInferenceBinding(params: {
  cfg: OpenClawConfig;
  agentId: string;
  model?: string;
  isGmailHook?: boolean;
  sessionEntry?: SessionEntry;
  executionSessionEntry?: Pick<SessionEntry, "modelOverride" | "providerOverride">;
  authorizeProfile?: (profileId: string, inherited: boolean) => Promise<(() => void) | undefined>;
  retainAuthorization?: (authority: AuthProfileAuthorization) => void;
}): Promise<CronInferenceBinding | undefined> {
  const owner = await resolveCronModelSelectionOwner({
    cfg: params.cfg,
    agentId: params.agentId,
    requiredAgentId: params.agentId,
  });
  const { config: cfg, agentId, agentDir, workspaceDir } = owner;
  const model = await resolveCronModelSelection({
    cfg,
    owner,
    agentConfigOverride: resolveAgentConfig(cfg, agentId),
    agentId,
    agentDir,
    workspaceDir,
    payloadModel: params.model,
    // Only a persistent execution target supplies model overrides; creator auth stays separate.
    sessionEntry: params.executionSessionEntry ?? {},
    isGmailHook: params.isGmailHook === true,
  });
  if (!model.ok) {
    throw new Error(model.error);
  }
  const cliExecutionProvider = resolveCliRuntimeExecutionProvider({
    cfg,
    agentId,
    provider: model.provider,
    modelId: model.model,
    authProfileId: model.configuredProfileId,
  });
  // Backends that never forward a stored profile own their login; nothing here can bind it.
  if (
    cliExecutionProvider &&
    !cliBackendAcceptsAuthProfileForwarding({
      provider: cliExecutionProvider,
      config: cfg,
      agentId,
    })
  ) {
    return undefined;
  }
  // A temporary creator model does not change the model an unpinned job will run.
  const creatorProvider =
    params.sessionEntry?.providerOverride ?? params.sessionEntry?.modelProvider;
  const creatorSession =
    creatorProvider && creatorProvider !== model.provider ? undefined : params.sessionEntry;
  let selection: Awaited<ReturnType<typeof resolveSessionAuthSelection>>;
  if (cliExecutionProvider) {
    // Record the account the CLI backend forwards, not a separate inferred owner.
    const selectedProfileId = model.configuredProfileId ?? creatorSession?.authProfileOverride;
    const profileId = await resolveCliExecutionAuthProfileId({
      cliExecutionProvider,
      model: model.model,
      authProfileProvider: model.provider,
      config: cfg,
      agentDir,
      selected: selectedProfileId
        ? {
            authProfileId: selectedProfileId,
            authProfileIdSource:
              model.configuredProfileId ||
              creatorSession?.authProfileOverrideSource === "user" ||
              creatorSession?.authProfileOverrideSource === "user-link"
                ? "user"
                : "auto",
          }
        : undefined,
    });
    if (!profileId) {
      return undefined;
    }
    selection = {
      profileId,
      source: model.configuredProfileId ? "user" : "auto",
      routeRequirement: undefined,
    };
  } else {
    selection = await resolveSessionAuthSelection({
      cfg,
      agentId,
      agentDir,
      provider: model.provider,
      modelId: model.model,
      configuredProfileId: model.configuredProfileId ?? creatorSession?.authProfileOverride,
      sessionEntry: model.configuredProfileId ? undefined : creatorSession,
      isNewSession: false,
    });
  }
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
      modelId: model.model,
      config: cfg,
      agentId,
    });
    const [attempt] = prepareAgentRuntimeAuth({
      provider: model.provider,
      modelId: model.model,
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
    !model.configuredProfileId && selection.profileId === creatorSession?.authProfileOverride,
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
        model.configuredProfileId ||
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
