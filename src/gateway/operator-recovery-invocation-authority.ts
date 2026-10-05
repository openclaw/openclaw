import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import {
  prepareOperatorModelPolicy,
  restoreOperatorModelCeilings,
} from "../agents/operator-model-policy.js";
import type {
  GoalRecoveryIntent,
  TurnRecoveryIntent,
} from "../config/sessions/main-session-recovery.types.js";
import { readSessionPendingInputStage } from "../config/sessions/session-accessor.pending-inputs.js";
import { readPendingInputRecoveryIntent } from "../config/sessions/session-accessor.sqlite-pending-inputs.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { getPublishedOperatorPairingIdentity } from "../infra/device-pairing-publication.js";
import { loadPairedDevicePairingStoreRecordReadOnly } from "../infra/device-pairing-store-readonly.js";
import { getProcessGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  createSessionRepositoryWorkspaceStore,
  type PreparedRepositoryWorkspace,
} from "../state/session-repository-workspaces.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import { UserProfileNotFoundError } from "../state/user-profiles-schema.js";
import { captureGatewayAuthPolicy } from "./auth-policy.js";
import {
  captureGatewayDeviceRevocation,
  onGatewayDeviceSourceRevoked,
} from "./device-revocation.js";
import { factoryGitHubDispatchCredentialReader } from "./factory-github-proof.js";
import {
  resumeGatewayOperatorAccessGrant,
  GatewayOperatorAccessDeniedError,
  GatewayOperatorAccessUnavailableError,
} from "./operator-access-policy.js";
import { prepareRestoredAcceptedInput } from "./operator-recovery-accepted-input.js";
import {
  resolveOperatorRolePolicyForAssignment,
  onOperatorRolePolicyChanged,
} from "./operator-role-policy.js";
import {
  sourceRolePolicy,
  resolveOperatorRoleSourcePolicyGeneration,
} from "./operator-role-source-policy.js";
import type { ExplicitAcceptedInputRecovery } from "./server-instance-runtime.types.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { readGatewaySharedAuthGeneration } from "./server-shared-auth-generation.js";
import { authorizePreparedSessionMutation } from "./session-sharing-policy.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";

/** Revalidate saved references; issue a new process-bound restriction, never revive the old run. */
export async function restoreGatewayGoalRecoveryAuthority(params: {
  intent: GoalRecoveryIntent | TurnRecoveryIntent;
  acceptedTurn?: TurnRecoveryIntent;
  explicitAcceptedInput?: ExplicitAcceptedInputRecovery;
  agentId: string;
  sessionKey: string;
  context: GatewayRequestContext;
  assertContextCurrent: () => void;
}): Promise<{
  authority: AdmittedRunOperatorAuthority;
  release: () => void;
  prepareAcceptedInput?: (assertDispatchCurrent: () => void) => Promise<string | undefined>;
}> {
  const intent = params.intent;
  const inputIntent = params.acceptedTurn ?? ("runId" in intent ? intent : undefined);
  const basis = intent.issuer;
  const explicit = params.explicitAcceptedInput;
  const matchesIntent = (
    current: GoalRecoveryIntent | TurnRecoveryIntent | undefined,
    expected: GoalRecoveryIntent | TurnRecoveryIntent,
  ) =>
    isDeepStrictEqual(current, expected) ||
    Boolean(explicit && isDeepStrictEqual(current, explicit.predecessor));
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === "string");
  if (
    (explicit &&
      (!("runId" in intent) ||
        explicit.profileId !== basis.profileId ||
        explicit.accountId !== basis.factoryActor?.accountId)) ||
    (params.acceptedTurn &&
      (!("goalId" in intent) ||
        params.acceptedTurn.sessionId !== intent.sessionId ||
        params.acceptedTurn.sessionKey !== intent.sessionKey ||
        params.acceptedTurn.lifecycleRevision !== intent.lifecycleRevision ||
        !isDeepStrictEqual(params.acceptedTurn.issuer, basis))) ||
    process.env.FACTORY_AUTH_MODE !== "github" ||
    intent.sessionKey !== params.sessionKey ||
    !isRecord(basis) ||
    basis.version !== 1 ||
    typeof basis.profileId !== "string" ||
    !isRecord(basis.factoryActor) ||
    basis.factoryActor.host !== "microsoft.ghe.com" ||
    typeof basis.factoryActor.accountId !== "number" ||
    !Number.isSafeInteger(basis.factoryActor.accountId) ||
    basis.factoryActor.accountId <= 0 ||
    !(basis.assignedRole === null || typeof basis.assignedRole === "string") ||
    !(basis.rolePolicyGeneration === null || typeof basis.rolePolicyGeneration === "string") ||
    !strings(basis.aliasBindingIds) ||
    !strings(basis.scopes) ||
    !strings(basis.modelCeilings) ||
    !isRecord(basis.device) ||
    typeof basis.device.deviceId !== "string" ||
    typeof basis.device.identity !== "string" ||
    !isRecord(basis.authPrincipal) ||
    basis.authPrincipal.role !== "operator" ||
    ![
      "none",
      "token",
      "password",
      "tailscale",
      "device-token",
      "bootstrap-token",
      "trusted-proxy",
    ].some((method) => method === basis.authPrincipal.authMethod) ||
    !(
      basis.authPrincipal.verifiedIdentity === undefined ||
      typeof basis.authPrincipal.verifiedIdentity === "string"
    ) ||
    !(
      basis.authPrincipal.authModeOverride === undefined ||
      ["none", "token", "password", "trusted-proxy"].some(
        (mode) => mode === basis.authPrincipal.authModeOverride,
      )
    ) ||
    !(
      basis.authPrincipal.browserOrigin === undefined ||
      (isRecord(basis.authPrincipal.browserOrigin) &&
        (basis.authPrincipal.browserOrigin.requestHost === undefined ||
          typeof basis.authPrincipal.browserOrigin.requestHost === "string") &&
        (basis.authPrincipal.browserOrigin.origin === undefined ||
          typeof basis.authPrincipal.browserOrigin.origin === "string") &&
        (basis.authPrincipal.browserOrigin.isLocalClient === undefined ||
          typeof basis.authPrincipal.browserOrigin.isLocalClient === "boolean"))
    ) ||
    typeof basis.authPolicyGeneration !== "string" ||
    !(basis.sharedAuthGeneration === null || typeof basis.sharedAuthGeneration === "string") ||
    !(
      basis.grant === null ||
      (isRecord(basis.grant) &&
        typeof basis.grant.pluginId === "string" &&
        typeof basis.grant.grantId === "string")
    )
  ) {
    throw new GatewayOperatorAccessDeniedError();
  }
  const factoryActor = Object.freeze({ ...basis.factoryActor });
  const context = params.context;
  const getConfig = context.getCommittedRuntimeConfig ?? context.getRuntimeConfig;
  let identity: Awaited<ReturnType<typeof prepareUserProfileIdentity>> | undefined;
  let session: Awaited<ReturnType<typeof prepareSessionMutationFacts>> | undefined;
  let device: ReturnType<typeof captureGatewayDeviceRevocation> | undefined;
  const repositoryStore = createSessionRepositoryWorkspaceStore({
    path: resolveOpenClawStateSqlitePath(),
  });
  let repository: PreparedRepositoryWorkspace | undefined;
  let references = 1;
  let sharedGrantCaptured = false;
  const sharedOwner = readGatewaySharedAuthGeneration(context);
  const abort = new AbortController();
  const subscriptions: Array<() => void> = [];
  const releaseHold = () => {
    let released = false;
    return () => {
      if (!released && --references === 0) {
        subscriptions.splice(0).forEach((release) => release());
        session?.release();
        identity?.release();
        device?.release();
      }
      released = true;
    };
  };
  const release = releaseHold();
  const deny = (): never => {
    throw new GatewayOperatorAccessDeniedError();
  };
  const currentRole = () => {
    const profile = identity!.readCurrentFacts(basis.aliasBindingIds);
    if (profile.profile.assignedRole !== basis.assignedRole) {
      deny();
    }
    if (!profile.profile.emails.includes(`github:${factoryActor.host}:${factoryActor.accountId}`)) {
      deny();
    }
    const policy = resolveOperatorRolePolicyForAssignment(
      basis.profileId,
      profile.profile.assignedRole,
      getConfig(),
      profile.profile.githubLogin ?? null,
    );
    if (resolveOperatorRoleSourcePolicyGeneration(policy) !== basis.rolePolicyGeneration) {
      deny();
    }
    return { ...profile, policy };
  };
  const client = createSyntheticPluginRuntimeClient({
    operatorRoleActor: { kind: "operator", profileId: basis.profileId },
    scopes: [...basis.scopes],
  });
  const assertPrepared = () => {
    if (references === 0) {
      deny();
    }
    params.assertContextCurrent();
    abort.signal.throwIfAborted();
    const config = getConfig();
    if (
      createHash("sha256")
        .update(captureGatewayAuthPolicy(config, basis.authPrincipal).grantGeneration)
        .digest("hex") !== basis.authPolicyGeneration
    ) {
      deny();
    }
    if (basis.sharedAuthGeneration !== null) {
      const shared = readGatewaySharedAuthGeneration(context);
      if (!shared || shared !== sharedOwner || shared.requiredGeneration === undefined) {
        throw new GatewayOperatorAccessUnavailableError();
      }
      if (!sharedGrantCaptured && shared.requiredGeneration !== basis.sharedAuthGeneration) {
        deny();
      }
    }
    if (
      getPublishedOperatorPairingIdentity(basis.device.deviceId) !== basis.device.identity ||
      (device && !device.isCurrent())
    ) {
      deny();
    }
    const { profile, aliases, policy } = currentRole();
    if (
      !policy ||
      !roleScopesAllow({
        role: "operator",
        requestedScopes: basis.scopes,
        allowedScopes: policy.scopes,
      })
    ) {
      deny();
    }
    const facts = session!.readCurrent(config);
    const recovery = facts.target.entry.mainRestartRecovery;
    const currentIntent = "goalId" in intent ? recovery?.goalIntent : recovery?.turnIntent;
    if (
      !matchesIntent(currentIntent, intent) ||
      (inputIntent && !matchesIntent(recovery?.turnIntent, inputIntent)) ||
      facts.target.entry.sessionId !== intent.sessionId ||
      facts.target.entry.lifecycleRevision !== intent.lifecycleRevision ||
      authorizePreparedSessionMutation(
        { cfg: config, client, sessionKey: params.sessionKey, agentId: params.agentId },
        facts,
        { policy, aliases },
      )
    ) {
      deny();
    }
    return profile;
  };
  const assertCurrent = () => {
    const profile = assertPrepared();
    resumeGatewayOperatorAccessGrant(profile, getConfig(), basis.grant);
    assertPrepared();
  };
  const assertGoalCurrent = async () => {
    assertCurrent();
    const facts = session!.readCurrent(getConfig());
    const workspaceId = await withSessionEntryReadOnlyInWorker(
      {
        agentId: facts.target.agentId,
        storePath: facts.sourcePath ?? facts.target.storePath,
        sessionKey: facts.target.storeKey,
        projection: "list",
        hydrateSkillPromptRefs: false,
        readConsistency: "latest",
      },
      assertCurrent,
      async (loaded, owner) => {
        owner.assertCurrent();
        if (!loaded.ok) {
          throw loaded.error;
        }
        const entry = loaded.value;
        const goal = entry?.goal;
        if (
          explicit &&
          (goal?.id !== explicit.goalId ||
            goal.status !== "paused" ||
            entry?.goalPauseOrigin !== "manual" ||
            goal.pausedAt !== explicit.pausedAt)
        ) {
          deny();
        }
        if (
          entry?.sessionId !== intent.sessionId ||
          entry.lifecycleRevision !== intent.lifecycleRevision ||
          (inputIntent &&
            (!matchesIntent(entry.mainRestartRecovery?.turnIntent, inputIntent) ||
              entry.repositoryWorkspaceId !== inputIntent.repositoryWorkspaceId)) ||
          ("goalId" in intent
            ? goal?.id !== intent.goalId ||
              (goal.status !== "active" &&
                !(goal.status === "paused" && entry.goalPauseOrigin === "terminal-error"))
            : !matchesIntent(entry.mainRestartRecovery?.turnIntent, intent) ||
              entry.repositoryWorkspaceId !== intent.repositoryWorkspaceId ||
              (goal &&
                goal.status !== "active" &&
                !(explicit && goal.status === "paused" && entry.goalPauseOrigin === "manual") &&
                !(goal.status === "paused" && entry.goalPauseOrigin === "terminal-error")))
        ) {
          throw new GatewayOperatorAccessDeniedError();
        }
        return entry.repositoryWorkspaceId;
      },
    );
    assertCurrent();
    if (inputIntent) {
      const captured = await readSessionPendingInputStage(
        {
          agentId: session!.storageTarget.agentId,
          sessionKey: session!.storageTarget.canonicalKey,
          storePath: session!.storageTarget.storePath,
          sessionId: intent.sessionId,
        },
        inputIntent.idempotencyKey,
        assertCurrent,
      );
      assertCurrent();
      if (!captured.current) {
        deny();
      }
      const input = captured.existing;
      const queuedInputId = captured.entry?.mainRestartRecovery?.queuedInputId;
      const capturedInput = input && readPendingInputRecoveryIntent(input);
      if (
        input?.recovery_intent_json != null &&
        (!capturedInput || !isDeepStrictEqual(capturedInput.intent, inputIntent))
      ) {
        deny();
      }
      if (
        queuedInputId &&
        !explicit &&
        (queuedInputId !== inputIntent.inputId ||
          (input &&
            (!capturedInput?.queued || !isDeepStrictEqual(capturedInput.intent, inputIntent))))
      ) {
        deny();
      }
      if (
        input
          ? input.input_id !== inputIntent.inputId ||
            input.run_id !== inputIntent.runId ||
            input.state === "cancelled" ||
            input.session_id !== intent.sessionId
          : captured.committed?.messageId !== inputIntent.inputId
      ) {
        deny();
      }
    }
    return workspaceId;
  };
  let modelConfig: ReturnType<typeof getConfig> | undefined;
  let modelMetadata: ReturnType<typeof getProcessGatewayPluginMetadataSnapshot>;
  let modelPolicy: ReturnType<typeof prepareOperatorModelPolicy>;
  const readModelPolicy = () => {
    assertCurrent();
    const config = getConfig();
    const metadata = getProcessGatewayPluginMetadataSnapshot();
    if (config !== modelConfig || metadata !== modelMetadata) {
      modelPolicy = restoreOperatorModelCeilings(basis.modelCeilings, {
        cfg: config,
        policy: currentRole().policy?.modelPolicy,
        manifestPlugins: metadata ?? [],
      });
      modelConfig = config;
      modelMetadata = metadata;
    }
    return modelPolicy;
  };
  const recheck = () => {
    try {
      assertCurrent();
    } catch (error) {
      abort.abort(error);
    }
  };
  try {
    params.assertContextCurrent();
    const preparationConfigs = [
      { gateway: { roles: structuredClone(getConfig().gateway?.roles) } },
    ];
    let onProfileChange = () => {};
    let onConfigChange = () => {
      const config = getConfig();
      if (
        createHash("sha256")
          .update(captureGatewayAuthPolicy(config, basis.authPrincipal).grantGeneration)
          .digest("hex") !== basis.authPolicyGeneration
      ) {
        abort.abort(new GatewayOperatorAccessDeniedError());
      }
      preparationConfigs.push({ gateway: { roles: structuredClone(config.gateway?.roles) } });
    };
    subscriptions.push(
      onUserProfilesChanged(() => onProfileChange()),
      onOperatorRolePolicyChanged((change) => {
        if (change.kind === "assignment" && change.profileId === basis.profileId) {
          abort.abort(new GatewayOperatorAccessDeniedError());
        } else if (change.kind === "config" && change.context === context) {
          onConfigChange();
        }
      }),
    );
    if (basis.sharedAuthGeneration !== null && sharedOwner) {
      subscriptions.push(
        sharedOwner.onInvalidated(
          basis.sharedAuthGeneration,
          () => abort.abort(new GatewayOperatorAccessDeniedError()),
          captureGatewayAuthPolicy(getConfig(), basis.authPrincipal),
        ),
      );
    }
    identity = await prepareUserProfileIdentity(basis.profileId);
    params.assertContextCurrent();
    abort.signal.throwIfAborted();
    const originalRoleFacts = currentRole();
    const capturedSourcePolicy = structuredClone(sourceRolePolicy(originalRoleFacts.policy));
    onProfileChange = () => {
      try {
        currentRole();
      } catch (error) {
        abort.abort(error);
      }
    };
    session = await prepareSessionMutationFacts({
      cfg: getConfig(),
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    });
    params.assertContextCurrent();
    abort.signal.throwIfAborted();
    await loadPairedDevicePairingStoreRecordReadOnly(basis.device.deviceId);
    assertCurrent();
    if (
      preparationConfigs.some(
        (config) =>
          resolveOperatorRoleSourcePolicyGeneration(
            resolveOperatorRolePolicyForAssignment(
              basis.profileId,
              basis.assignedRole,
              config,
              originalRoleFacts.profile.githubLogin ?? null,
            ),
          ) !== basis.rolePolicyGeneration,
      )
    ) {
      deny();
    }
    preparationConfigs.length = 0;
    onProfileChange = recheck;
    onConfigChange = recheck;
    const initialWorkspaceId = await assertGoalCurrent();
    if (initialWorkspaceId) {
      repository = await repositoryStore.prepare(initialWorkspaceId);
      assertCurrent();
      if ((await assertGoalCurrent()) !== initialWorkspaceId) {
        deny();
      }
    }
    const preparedModels = readModelPolicy();
    if (preparedModels && preparedModels.models.length === 0) {
      deny();
    }
    device = captureGatewayDeviceRevocation(
      context,
      { deviceId: basis.device.deviceId, role: "operator" },
      () => {
        // The source check below owns these same facts without recursing into its device guard.
        return references > 0 && !abort.signal.aborted;
      },
    );
    const onDeviceRevoked = onGatewayDeviceSourceRevoked(device.isCurrent, recheck);
    if (onDeviceRevoked) {
      subscriptions.push(onDeviceRevoked);
    }
    assertCurrent();
    sharedGrantCaptured = true;
    const authority: AdmittedRunOperatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: basis.profileId,
      scopes: basis.scopes,
      rolePolicy: capturedSourcePolicy && {
        sessionAccessCap: capturedSourcePolicy.sessions.others,
        sandboxRequired: capturedSourcePolicy.sandbox === "required",
        agents: capturedSourcePolicy.agents,
      },
      createFactoryGitHubDispatchCredentialReader: (target) => {
        const assertTargetCurrent = () => {
          assertCurrent();
          target.assertCurrent();
          if (
            target.agentId !== params.agentId ||
            target.sessionKey !== params.sessionKey ||
            target.sessionId !== intent.sessionId ||
            new URL(target.repositoryUrl).hostname !== factoryActor.host
          ) {
            deny();
          }
        };
        assertTargetCurrent();
        const workspaceId = initialWorkspaceId;
        const acceptedRepository = repository;
        if (!workspaceId || !acceptedRepository) {
          throw new GatewayOperatorAccessDeniedError();
        }
        const assertRepositoryFactsCurrent = () => {
          const current = acceptedRepository.current();
          const sessionFacts = session!.readCurrent(getConfig());
          if (
            !current ||
            sessionFacts.target.entry.repositoryWorkspaceId !== workspaceId ||
            current.workspaceId !== workspaceId ||
            current.agentId !== target.agentId ||
            current.sessionKey !== target.sessionKey ||
            current.url !== target.repositoryUrl
          ) {
            deny();
          }
        };
        const assertRepositoryCurrent = async () => {
          assertTargetCurrent();
          const beforeWorkspaceId = await assertGoalCurrent();
          assertTargetCurrent();
          assertRepositoryFactsCurrent();
          if (beforeWorkspaceId !== workspaceId) {
            deny();
          }
          if ((await assertGoalCurrent()) !== workspaceId) {
            deny();
          }
        };
        const reader = factoryGitHubDispatchCredentialReader({
          ...target,
          issuerAuthority: authority,
          assertCurrent: () => {
            assertTargetCurrent();
            assertRepositoryFactsCurrent();
          },
        });
        if (!reader) {
          throw new GatewayOperatorAccessDeniedError();
        }
        return async (env, admission) => {
          await assertRepositoryCurrent();
          const token = await reader(env, admission);
          await assertRepositoryCurrent();
          return token;
        };
      },
      gatewayAccessGrant: basis.grant,
      assertCurrent,
      signal: abort.signal,
      retain: () => {
        assertCurrent();
        references += 1;
        return releaseHold();
      },
      readCurrentRoleAssignment: () => {
        assertCurrent();
        return currentRole().profile.assignedRole;
      },
      readCurrentGithubLogin: () => {
        assertCurrent();
        return currentRole().profile.githubLogin ?? null;
      },
      get modelPolicy() {
        return readModelPolicy();
      },
      captureRestartRecoveryIssuer: () => {
        assertCurrent();
        return { ...basis, factoryActor };
      },
      onModelPolicyChanged: (listener) =>
        onOperatorRolePolicyChanged((change) => {
          if (change.kind === "config" && change.context === context) {
            listener();
          }
        }),
    });
    const prepareAcceptedInput = inputIntent
      ? (assertDispatchCurrent: () => void) =>
          prepareRestoredAcceptedInput({
            inputIntent,
            target: session!.storageTarget,
            getConfig,
            assertGoalCurrent,
            assertCurrent: () => {
              assertDispatchCurrent();
              authority.assertCurrent();
            },
          })
      : undefined;
    return { authority, release, prepareAcceptedInput };
  } catch (error) {
    release();
    if (error instanceof GatewayOperatorAccessDeniedError) {
      throw error;
    }
    if (error instanceof UserProfileNotFoundError) {
      throw new GatewayOperatorAccessDeniedError();
    }
    throw new GatewayOperatorAccessUnavailableError();
  }
}
