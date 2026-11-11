import { resolveAgentConfig } from "../agents/agent-scope.js";
import {
  AuthProfileAuthorizationError,
  type AuthProfileAuthorization,
} from "../agents/auth-profiles/authorization-contract.js";
import { captureAuthProfileAuthorization } from "../agents/auth-profiles/authorization.js";
import {
  resolveAuthProfileEligibility,
  resolveExplicitAuthOrderSelection,
} from "../agents/auth-profiles/order.js";
import { resolveSessionAuthSelection } from "../agents/auth-profiles/session-override.js";
import { ensureAuthProfileStoreAsync } from "../agents/auth-profiles/store-runtime.js";
import {
  cliBackendAcceptsAuthProfileForwarding,
  resolveCliExecutionAuthSelection,
} from "../agents/cli-execution-auth.js";
import { resolveAgentHarnessSelectionDecision } from "../agents/harness/selection-decision.js";
import { resolveProviderModelAuthPolicy } from "../agents/model-auth-policy.js";
import { hasSyntheticLocalProviderAuthConfig } from "../agents/model-auth-provider-config.js";
import { resolveCliRuntimeExecutionProvider } from "../agents/model-runtime-aliases.js";
import { isCliProvider } from "../agents/model-selection-cli.js";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import { isConfiguredKeyAuthSource } from "../agents/provider-model-auth-source-plan.js";
import { prepareAgentRuntimeAuth } from "../agents/runtime-plan/prepare-auth.js";
import { resolveSessionRuntimeOverrideForProvider } from "../agents/session-runtime-compat.js";
import { resolveSimpleCompletionSelectionForAgent } from "../agents/simple-completion-selection.js";
import { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { workerInferencePlacement } from "../gateway/worker-environments/inference-placement.js";
import { logWarn } from "../logger.js";
import { modelKey } from "../shared/model-key.js";
import { isUserModelAuthProfileId } from "../state/user-model-account-id.js";
import { prepareUserModelAccountAuthority } from "../state/user-model-account-operations.js";
import { cronExecutionActor } from "./human-owner.js";
import {
  type CronInferenceBinding,
  type CronRunInferencePolicy,
  describeCronInferenceBinding,
} from "./inference-binding.js";
import { resolveCronCandidateExecution } from "./isolated-agent/candidate-execution.js";
import {
  resolveCronModelSelection,
  resolveCronModelSelectionOwner,
} from "./isolated-agent/model-selection.js";
import type { CronStoredJob } from "./types.js";

/** Capture a current owner; null means an explicit, validated native CLI account selection. */
export async function captureCronInferenceBinding(params: {
  cfg: OpenClawConfig;
  agentId: string;
  model?: string;
  isGmailHook?: boolean;
  sessionEntry?: SessionEntry;
  executionSessionEntry?: Pick<
    SessionEntry,
    | "modelOverride"
    | "providerOverride"
    | "modelOverrideSource"
    | "modelOverrideFallbackOriginProvider"
    | "modelOverrideFallbackOriginModel"
  >;
  /**
   * The entry the cron session takes its runtime override from: the target row of a
   * `session:` job, or what a `current` job carries from its creating conversation.
   */
  runtimeSessionEntry?: Pick<SessionEntry, "agentRuntimeOverride">;
  /** Existing stored-account edits retain this runtime; native adoption must also work without it. */
  recordedRuntime?: string;
  authorizeProfile?: (profileId: string, inherited: boolean) => Promise<(() => void) | undefined>;
  retainAuthorization?: (authority: AuthProfileAuthorization) => void;
}): Promise<CronInferenceBinding | null | undefined> {
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
  return captureSelectedCronInferenceBinding(params, owner, model);
}

/** Primary overrides and native fallback selection share the same credential/runtime owner. */
async function captureSelectedCronInferenceBinding(
  params: Parameters<typeof captureCronInferenceBinding>[0],
  owner: Awaited<ReturnType<typeof resolveCronModelSelectionOwner>>,
  model: { provider: string; model: string; configuredProfileId?: string },
  requireAvailable = false,
  allowNativePrimary = false,
): Promise<CronInferenceBinding | null | undefined> {
  const { config: cfg, agentId, agentDir } = owner;
  // The account follows the config's runtime policy, so a job binds the account it always has.
  const cliExecutionProvider = resolveCliRuntimeExecutionProvider({
    cfg,
    agentId,
    provider: model.provider,
    modelId: model.model,
    authProfileId: model.configuredProfileId,
  });
  const resolveExecution = (runtimeEntry: typeof params.runtimeSessionEntry) =>
    resolveCronCandidateExecution(
      {
        cfg,
        agentId,
        provider: model.provider,
        model: model.model,
        sessionRuntimeOverride: resolveSessionRuntimeOverrideForProvider({
          provider: model.provider,
          entry: runtimeEntry,
          cfg,
        }),
        sessionEntry: runtimeEntry,
        authProfileId: model.configuredProfileId,
      },
      { isCliProvider, resolveEffectiveAgentRuntime },
    );
  // Backends that never forward a stored profile own their login; nothing here can bind it.
  if (
    cliExecutionProvider &&
    !cliBackendAcceptsAuthProfileForwarding({
      provider: cliExecutionProvider,
      config: cfg,
      agentId,
    })
  ) {
    if (requireAvailable && !allowNativePrimary) {
      throw new Error("runtime does not forward a supported stored account");
    }
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
    const selected = await resolveCliExecutionAuthSelection({
      cliExecutionProvider,
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
    if (selected?.kind === "native" && model.configuredProfileId) {
      // Clearing the binding also releases its runtime pin. Validate the session the next
      // run will actually inherit, not the pin that this transition removes.
      const { runtime, executionProvider, cliExecution } = resolveExecution(
        params.runtimeSessionEntry,
      );
      if (
        !cliExecution ||
        executionProvider !== cliExecutionProvider ||
        runtime !== cliExecutionProvider
      ) {
        throw new Error(
          `The selected native account is unavailable on automation runtime ${runtime}.`,
        );
      }
      if (params.recordedRuntime && params.recordedRuntime !== runtime) {
        throw new Error(
          `The automation runs on runtime ${params.recordedRuntime}, which is unavailable for this account; the edit would move it to runtime ${runtime}.`,
        );
      }
      return null;
    }
    if (selected?.kind !== "stored") {
      if (requireAvailable && !allowNativePrimary) {
        throw new Error("no available stored account for the configured CLI runtime");
      }
      return undefined;
    }
    selection = {
      profileId: selected.profileId,
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
    externalCli: { mode: "none" },
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
      if (
        requireAvailable &&
        source?.kind !== "direct" &&
        !allowNativePrimary &&
        !hasSyntheticLocalProviderAuthConfig({ cfg, provider: model.provider })
      ) {
        throw new Error("no eligible stored account or configured key");
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
  // Stored-account edits preserve their captured runtime; new jobs follow the target session.
  const { runtime } = resolveExecution(
    params.recordedRuntime
      ? { agentRuntimeOverride: params.recordedRuntime }
      : params.runtimeSessionEntry,
  );
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
      runtime,
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
        `Automation inference ${describeCronInferenceBinding(params.binding)} was replaced. Explicitly select an authorized account again.`,
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
        `Automation inference ${describeCronInferenceBinding(params.binding)} was removed or signed out. Explicitly select an authorized account again.`,
        { cause: error },
      );
    }
    throw error;
  }
}

/** Resolve an optional alternate without choosing an ambient or round-robin billing account. */
export async function captureCronAlternateInferenceBinding(
  params: Parameters<typeof captureCronInferenceBinding>[0] & {
    model: string;
    /** Native-owned primary login behavior predates automatic account capture. */
    primary?: boolean;
  },
): Promise<CronInferenceBinding | undefined> {
  const selected = resolveSimpleCompletionSelectionForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    modelRef: params.model,
  });
  if (!selected) {
    throw new Error("The fallback model could not be resolved.");
  }
  const owner = await resolveCronModelSelectionOwner({
    cfg: params.cfg,
    agentId: params.agentId,
    requiredAgentId: params.agentId,
  });
  let profileId = selected.profileId;
  if (!profileId) {
    const store = await ensureAuthProfileStoreAsync(owner.agentDir, {
      config: params.cfg,
      externalCli: { mode: "none" },
      allowKeychainPrompt: false,
    });
    const cliProvider = resolveCliRuntimeExecutionProvider({
      cfg: params.cfg,
      agentId: params.agentId,
      provider: selected.provider,
      modelId: selected.modelId,
    });
    const cliSelection = cliProvider
      ? await resolveCliExecutionAuthSelection({
          cliExecutionProvider: cliProvider,
          authProfileProvider: selected.provider,
          config: params.cfg,
          agentDir: owner.agentDir,
        })
      : undefined;
    const accountProvider =
      cliSelection?.kind === "stored" ? cliSelection.provider : (cliProvider ?? selected.provider);
    const { order } = resolveExplicitAuthOrderSelection({
      storeOrder: store.order,
      configuredOrder: params.cfg.auth?.order,
      providerKey: accountProvider,
      providerAuthKey: resolveProviderIdForAuth(accountProvider, { config: params.cfg }),
    });
    const eligible = (id: string) =>
      resolveAuthProfileEligibility({
        cfg: params.cfg,
        store,
        provider: accountProvider,
        profileId: id,
        includePendingOAuthRefresh: true,
      }).eligible;
    const choices =
      order === undefined ? Object.keys(store.profiles).filter(eligible) : order.filter(eligible);
    if (choices.length > 1 && order === undefined) {
      throw new Error("multiple eligible accounts; select model@profile");
    }
    profileId = choices[0];
  }
  // This ref came from the native fallback chain, not a primary model override.
  // Do not reapply the primary override allowlist or inherit the creator account.
  const binding = await captureSelectedCronInferenceBinding(
    { ...params, sessionEntry: undefined, recordedRuntime: undefined },
    owner,
    { provider: selected.provider, model: selected.modelId, configuredProfileId: profileId },
    true,
    params.primary === true,
  );
  if (binding === null && !params.primary) {
    throw new Error("runtime does not forward a supported stored account");
  }
  return binding ?? undefined;
}

/** Derive native policy once per admitted run, without rewriting or rescheduling stored jobs. */
export async function inheritCronInferencePolicy(params: {
  cfg: OpenClawConfig;
  agentId: string;
  job: CronStoredJob;
  primary: { provider: string; model: string };
  candidates: readonly { provider: string; model: string }[];
  fallbacks: readonly string[];
  primaryProfileId?: string;
  runtimeSessionEntry?: Pick<SessionEntry, "agentRuntimeOverride">;
}): Promise<CronRunInferencePolicy> {
  const job: CronStoredJob = params.job;
  if (job.runtimeAuthority) {
    return {};
  }
  const grants: NonNullable<CronRunInferencePolicy["grants"]> = { ...job.inferenceGrants };
  const policy = { binding: job.inferenceBinding, grants };
  const selections = params.fallbacks.map((modelRef) =>
    resolveSimpleCompletionSelectionForAgent({
      cfg: params.cfg,
      agentId: params.agentId,
      modelRef,
    }),
  );
  for (const candidate of params.candidates) {
    const key = modelKey(candidate.provider, candidate.model);
    const primary = key === modelKey(params.primary.provider, params.primary.model);
    if (primary && policy.binding?.provider === candidate.provider) {
      continue;
    }
    const profileId = primary
      ? params.primaryProfileId
      : selections.find(
          (selection) =>
            selection?.provider === candidate.provider && selection.modelId === candidate.model,
        )?.profileId;
    const saved = grants[key];
    if (saved && (!profileId || saved.profileId === profileId)) {
      if (primary && !policy.binding) {
        policy.binding = saved;
      }
      continue;
    }
    // A new model does not mint a new lifetime for an already-recorded account.
    const retained = profileId
      ? [policy.binding, ...Object.values(grants)].find(
          (binding) => binding?.provider === candidate.provider && binding.profileId === profileId,
        )
      : policy.binding?.provider === candidate.provider
        ? policy.binding
        : undefined;
    const cliProvider = resolveCliRuntimeExecutionProvider({
      cfg: params.cfg,
      agentId: params.agentId,
      provider: candidate.provider,
      modelId: candidate.model,
      authProfileId: profileId,
    });
    if (retained && (!cliProvider || cliProvider === retained.runtime)) {
      grants[key] = retained;
      if (primary && !policy.binding) {
        policy.binding = retained;
      }
      continue;
    }
    try {
      const captured = await captureCronAlternateInferenceBinding({
        cfg: params.cfg,
        agentId: params.agentId,
        model: profileId ? key + "@" + profileId : key,
        primary: primary && !policy.binding,
        runtimeSessionEntry: primary ? params.runtimeSessionEntry : undefined,
        authorizeProfile: async (authProfileId) => {
          if (!isUserModelAuthProfileId(authProfileId)) {
            return undefined;
          }
          const actor = cronExecutionActor(job);
          if (actor?.type !== "human" || actor.source !== "profile" || !actor.id) {
            throw new Error("no authenticated owner for this personal inference account");
          }
          const authority = await prepareUserModelAccountAuthority({
            profileId: actor.id,
            authProfileId,
          });
          const assertCurrent = () => {
            if (!authority?.isCurrent()) {
              throw new Error(
                "personal inference account is unavailable to this automation's owner",
              );
            }
          };
          assertCurrent();
          return assertCurrent;
        },
      });
      const recorded =
        captured &&
        [policy.binding, ...Object.values(job.inferenceGrants ?? {})].find(
          (binding) => binding?.profileId === captured.profileId,
        );
      const binding =
        captured && recorded
          ? { ...captured, authorizationId: recorded.authorizationId }
          : captured;
      grants[key] = binding;
      if (primary && !policy.binding) {
        policy.binding = binding;
      }
    } catch (error) {
      delete grants[key];
      logWarn("[cron:" + job.id + "] Fallback " + key + " unavailable: " + String(error));
    }
  }
  return policy;
}
