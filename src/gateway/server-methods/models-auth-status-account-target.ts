import type { ModelsAuthStatusParams } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import { resolveAuthProfileMetadata } from "../../agents/auth-profiles/identity.js";
import { resolveAuthProfileOrder } from "../../agents/auth-profiles/order.js";
import { readSessionRuntimeOwnershipAsync } from "../../agents/harness/session-runtime-ownership.js";
import {
  createModelCatalogDecisions,
  resolveCatalogDecisionRuntime,
} from "../../agents/model-catalog-decisions.js";
import { createModelCatalogSnapshotView } from "../../agents/model-catalog-view.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { withCurrentReadAuthority } from "../../shared/current-read-authority.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { prepareOperatorModelPresentation } from "../operator-model-presentation.js";
import { authorizeCurrentOperatorRoleScopes } from "../operator-role-policy.js";
import { hasGatewayAdminScope } from "../operator-scopes.js";
import {
  readPreparedCatalog,
  type PreparedGatewayModelCatalogSnapshot,
} from "../server-model-catalog-auth.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import type { ChatMetadataReadParams } from "./chat-metadata-contract.js";
import { resolveChatMetadataReadParams } from "./chat-metadata-handler.js";
import {
  prepareSessionAcpMeta,
  resolveRequiredWorkerInferenceProfileId,
} from "./chat-metadata-session-projection.js";
import type { ModelAuthStatusResult } from "./models-auth-status.types.js";
import { buildModelsListResult } from "./models-list-result.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type AccountTarget = NonNullable<ModelsAuthStatusParams["accountTarget"]>;

function prepareSharedAccountProjection(
  { context, client }: GatewayRequestHandlerOptions,
  scope: ChatMetadataReadParams,
  snapshot: PreparedGatewayModelCatalogSnapshot,
  catalog: ModelsListResult,
  target: AccountTarget,
  result: ModelAuthStatusResult,
) {
  const { model, provider, runtime } = target;
  const cfg = context.getRuntimeConfig();
  if (!snapshot.isCurrent()) {
    return undefined;
  }
  const policy = prepareOperatorModelPresentation({
    cfg,
    policyConfig: context.getCommittedRuntimeConfig?.() ?? cfg,
    client,
    metadataSnapshot: snapshot.metadataSnapshot,
  });
  const visible = policy?.forAgent(scope.agentId, catalog.models).catalog(catalog) ?? catalog;
  const row = visible.models.find(
    (candidate) => candidate.id === model && candidate.provider === provider,
  );
  const choice =
    (row?.agentRuntime?.id ?? "openclaw") === runtime
      ? row
      : row?.runtimeChoices?.find((candidate) => candidate.agentRuntime.id === runtime);
  if (
    !row ||
    row.manualSelectionAllowed !== true ||
    choice?.available !== true ||
    choice.manualSelectionAllowed === false
  ) {
    return undefined;
  }
  const view = createModelCatalogSnapshotView(snapshot.config, snapshot);
  const logical = view.logicalEntries.find(
    (entry) => entry.id === model && entry.provider === provider,
  );
  if (!logical) {
    return undefined;
  }
  const route = view.selectRuntimeEntry({ entry: logical, runtimeId: runtime });
  if (!route.variants.length) {
    return undefined;
  }
  const variants = view.variantsOf(logical) ?? [logical];
  const store = snapshot.authStore;
  const candidates = resolveAuthProfileOrder({
    cfg: snapshot.config,
    store,
    provider,
    forModel: model,
    readinessMode: "read-only",
    authAliasLookupParams: {
      config: snapshot.config,
      workspaceDir: snapshot.workspaceDir,
      metadataSnapshot: snapshot.metadataSnapshot,
    },
  }).flatMap((id) => {
    if (isUserModelAuthProfileId(id) || store.profiles[id]?.provider !== provider) {
      return [];
    }
    const decisions = createModelCatalogDecisions({
      cfg: snapshot.config,
      agentId: scope.agentId,
      agentDir: snapshot.agentDir,
      workspaceDir: snapshot.workspaceDir,
      snapshot,
      metadataSnapshot: snapshot.metadataSnapshot,
      pluginRegistry: snapshot.pluginRegistry,
      isCurrent: snapshot.isCurrent,
      observationConfig: snapshot.observationConfig,
      preparedAuthStore: store,
      preparedRuntimeAuthModes: snapshot.authModes,
      preparedRuntimeAuthMaterializations: snapshot.authMaterializations,
      preparedSyntheticAuthComplete: snapshot.catalogComplete,
      profileProvider: provider,
      preferredProfileId: id,
      pinnedProfileId: id,
      runtimeOverride: scope.sessionEntry?.agentRuntimeOverride,
      accountCatalog: snapshot.accountCatalog,
    });
    return [{ id, decisions }];
  });
  return {
    candidates,
    read: () => {
      const profileIds = candidates
        .filter(({ id, decisions }) => {
          const host = decisions.evaluateEntry(route.entry, variants, runtime);
          const evaluation = decisions.evaluateNative(route.entry, host, runtime);
          // A usable native login or shared failover is not proof of the requested pin.
          const selectedRuntime = resolveCatalogDecisionRuntime({
            cfg: snapshot.config,
            agentId: scope.agentId,
            entry: logical,
            evaluation: decisions.evaluateEntry(logical, variants),
            pluginRegistry: snapshot.pluginRegistry,
            resolveOpenAIProviderRoutes: decisions.resolveOpenAIProviderRoutes,
          });
          return (
            (scope.sessionEntry?.agentRuntimeOverride ?? selectedRuntime?.id ?? "openclaw") ===
              runtime &&
            evaluation.availability === true &&
            evaluation.selectedProfileId === id &&
            evaluation.selectedCredential?.source === "profile" &&
            evaluation.selectedCredential.profileId === id &&
            !evaluation.runtimeAuth &&
            decisions.isCurrent()
          );
        })
        .map(({ id }) => id);
      const admin = hasGatewayAdminScope(client);
      const inventory = Object.entries(store.profiles)
        .flatMap(([id, credential]) =>
          credential.provider === provider && !isUserModelAuthProfileId(id) ? [id] : [],
        )
        .toSorted();
      const ordinals = new Map(inventory.map((id, index) => [id, index + 1]));
      return {
        ...result,
        accountTarget: {
          provider,
          model,
          runtime,
          accounts: profileIds.map((profileId) => {
            const metadata = admin
              ? resolveAuthProfileMetadata({ cfg: snapshot.config, store, profileId })
              : undefined;
            return {
              profileId,
              ordinal: inventory.length > 1 ? ordinals.get(profileId) : undefined,
              displayName: metadata?.displayName,
              email: metadata?.email,
            };
          }),
        },
      } satisfies ModelAuthStatusResult;
    },
  };
}

/** Report only a saved session's selectable shared pins. Never run auth refresh or usage probes. */
export async function readSharedAccountTarget(
  options: GatewayRequestHandlerOptions,
  target: AccountTarget,
  agentId?: string,
) {
  const { context, respond, client } = options;
  const { sessionKey, model, provider, runtime } = target;
  const result: ModelAuthStatusResult = {
    ts: Date.now(),
    providers: [],
    accountTarget: { model, provider, runtime, accounts: [] },
  };
  const empty = () => respond(true, result, undefined);
  const cfg = context.getRuntimeConfig();
  const requestParams = { key: sessionKey, agentId, model: `${provider}/${model}` };
  const scopes = client?.connect.scopes ?? [];
  const patchScope = authorizeOperatorScopesForMethod("sessions.patch", scopes, requestParams);
  if (
    !client ||
    !patchScope.allowed ||
    !authorizeOperatorScopesForMethod("models.authStatus", scopes).allowed ||
    authorizeCurrentOperatorRoleScopes(client, cfg)
  ) {
    return empty();
  }
  const scope = await resolveChatMetadataReadParams(options, { sessionKey, agentId });
  if (!scope) {
    return;
  }
  try {
    const admission = await resolveSessionMutationAuthorizationAsync({
      client,
      context,
      method: "sessions.patch",
      requestParams,
      sessionScope: patchScope.sessionScope,
      databaseAdmission: "read",
    });
    admission.authorization?.release?.();
    if (admission.error) {
      return empty();
    }
    const ownership = await readSessionRuntimeOwnershipAsync({ ...scope, config: cfg });
    scope.assertCurrent?.();
    if (
      !scope.sessionEntry?.sessionId ||
      // Harness-owned placement can substitute native auth after model availability is evaluated.
      // No prepared handoff receipt is published for it, so do not infer support from its config.
      runtime !== "openclaw" ||
      ownership ||
      scope.sessionEntry.modelSelectionLocked ||
      scope.workerInference ||
      resolveRequiredWorkerInferenceProfileId(scope, cfg) ||
      (await prepareSessionAcpMeta(scope, cfg))
    ) {
      return await withCurrentReadAuthority(scope, empty);
    }
    const snapshot = await withCurrentReadAuthority(scope, () =>
      readPreparedCatalog(context, scope.agentId),
    );
    if (!snapshot || snapshot.agentId !== scope.agentId || !snapshot.isCurrent()) {
      return await withCurrentReadAuthority(scope, empty);
    }
    const request = {
      agentId: scope.agentId,
      readScope: scope,
      requesterProfileId: scope.requesterProfileId,
      includeManualSelection: true,
      params: { view: "configured" as const, preparedOnly: true, includeDefaultModels: false },
    };
    const catalog =
      (await context.readPreparedModelsList?.(request)) ??
      (await buildModelsListResult({ ...request, source: { kind: "gateway", context } }));
    const prepare = await withCurrentReadAuthority(scope, () =>
      withPluginRuntimeRegistryScope(snapshot.pluginRegistry, () =>
        prepareSharedAccountProjection(options, scope, snapshot, catalog, target, result),
      ),
    );
    if (!prepare) {
      return await withCurrentReadAuthority(scope, empty);
    }
    // Reuse published per-account rejections and entitlements. A cold cache must never discover.
    for (const { decisions } of prepare.candidates) {
      await decisions.prepareSelectedAccountCatalog(() => scope.assertCurrent?.(), {
        refresh: false,
        withCurrent: scope.withCurrent,
      });
    }
    await withCurrentReadAuthority(scope, () => {
      if (!snapshot.isCurrent()) {
        return empty();
      }
      respond(
        true,
        withPluginRuntimeRegistryScope(snapshot.pluginRegistry, prepare.read),
        undefined,
      );
    });
  } finally {
    scope.release?.();
  }
}
