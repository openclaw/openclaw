import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import { resolveAuthProfileMetadata } from "../../agents/auth-profiles/identity.js";
import { resolveAuthProfileOrder } from "../../agents/auth-profiles/order.js";
import { isProfileInCooldown } from "../../agents/auth-profiles/usage-state.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { resolveOpenAICodexAuthIdentity } from "../../plugin-sdk/provider-openai-chatgpt-auth.js";
import { isModelInCredentialListing } from "../../plugins/provider-catalog-outcome.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { authorizeCurrentOperatorRoleScopes } from "../operator-role-policy.js";
import { hasGatewayAdminScope } from "../operator-scopes.js";
import { readPreparedCatalog } from "../server-model-catalog-auth.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import { sharedModelAccountOrdinals } from "../shared-model-account-ref.js";
import type { ChatMetadataReadParams } from "./chat-metadata-contract.js";
import {
  prepareSessionAcpMeta,
  resolveRequiredWorkerInferenceProfileId,
} from "./chat-metadata-session-projection.js";
import { managedCodexProfileForChoice } from "./models-list-public-projection.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Annotate only the actual saved Chat route, never the shared cached catalog or a draft. */
export async function prepareManagedCodexAccountDisplay(
  { context, client }: GatewayRequestHandlerOptions,
  scope: ChatMetadataReadParams,
  result: ModelsListResult,
) {
  const cfg = context.getRuntimeConfig();
  const entry = scope.sessionEntry;
  if (
    !client ||
    !scope.sessionKey ||
    !entry?.sessionId ||
    entry.modelSelectionLocked ||
    entry.pluginOwnerId ||
    scope.workerInference ||
    resolveRequiredWorkerInferenceProfileId(scope, cfg) ||
    (entry.agentRuntimeOverride && entry.agentRuntimeOverride !== "codex")
  ) {
    return undefined;
  }
  const selected = resolveSessionModelRef(cfg, entry, scope.agentId, {
    allowPluginNormalization: false,
  });
  const row =
    selected?.provider === "openai" &&
    result.models.find(
      (model) => model.provider === selected.provider && model.id === selected.model,
    );
  const alternate =
    row && row.agentRuntime?.id !== "codex" && entry.agentRuntimeOverride === "codex"
      ? row.runtimeChoices?.find((choice) => choice.agentRuntime.id === "codex")
      : undefined;
  const profileId = row && managedCodexProfileForChoice.get(alternate ?? row);
  if (!row || !profileId || isUserModelAuthProfileId(profileId)) {
    return undefined;
  }
  scope.assertCurrent?.();
  const owner = await readPreparedCatalog(context, scope.agentId);
  if (!owner || owner.agentId !== scope.agentId || !owner.isCurrent()) {
    return undefined;
  }
  const harness = owner.pluginRegistry?.agentHarnesses.find(
    (registration) => registration.harness.id === "codex",
  )?.harness;
  const observed = () =>
    harness?.readModelCatalogReadiness?.({
      config: owner.observationConfig,
      agentId: scope.agentId,
      agentDir: owner.agentDir,
      workspaceDir: owner.workspaceDir,
      provider: row.provider,
      modelId: row.id,
    })?.managedAccount;
  const active = observed();
  const store = owner.authStore;
  const credential = store.profiles[profileId];
  if (
    active?.profileId !== profileId ||
    credential?.type !== "oauth" ||
    credential.accountId !== active.accountId ||
    (await prepareSessionAcpMeta(scope, cfg))
  ) {
    return undefined;
  }
  const admin = hasGatewayAdminScope(client);
  const scopes = client.connect.scopes ?? [];
  const requestParams = {
    key: scope.sessionKey,
    agentId: scope.agentId,
    model: `${row.provider}/${row.id}`,
  };
  const patchScope = authorizeOperatorScopesForMethod("sessions.patch", scopes, requestParams);
  const canDistinguish =
    admin ||
    (result.accountSelection?.kind === "shared" &&
      result.accountSelection.authProfileId === profileId &&
      authorizeOperatorScopesForMethod("models.authStatus", scopes).allowed &&
      !authorizeCurrentOperatorRoleScopes(client, cfg));
  let otherCurrent: (() => boolean) | undefined;
  if (
    patchScope.allowed &&
    canDistinguish &&
    !owner.refreshFailed &&
    !owner.pendingProviders?.includes(row.provider)
  ) {
    const now = Date.now();
    const ids = resolveAuthProfileOrder({
      cfg: owner.config,
      store,
      provider: row.provider,
      forModel: row.id,
      readinessMode: "read-only",
      authAliasLookupParams: {
        config: owner.config,
        metadataSnapshot: owner.metadataSnapshot,
        workspaceDir: owner.workspaceDir,
      },
    });
    for (const id of ids) {
      const other = store.profiles[id];
      if (
        isUserModelAuthProfileId(id) ||
        other?.provider !== row.provider ||
        other.type !== "oauth" ||
        other.authFlow === "chatgpt-token-sharing" ||
        other.authFlow === "chatgpt-identity" ||
        !other.accountId ||
        other.accountId === active.accountId ||
        other.expires <= now ||
        isProfileInCooldown(store, id, now, row.id)
      ) {
        continue;
      }
      // Catalogs already obtained with this precise credential are evidence. A second saved
      // account (or even a non-expired token) alone does not establish access to this model.
      const cached = await owner.accountCatalog?.acquire({
        profileId: id,
        credential: other,
        allowDiscovery: false,
        load: async () => [],
      });
      scope.assertCurrent?.();
      const outcomes = cached?.hasPublishedCatalog ? cached.outcomes : owner.providerOutcomes;
      if (
        cached?.isCurrent() === false ||
        !isModelInCredentialListing(outcomes, {
          provider: row.provider,
          modelId: row.id,
          profileId: id,
        })
      ) {
        continue;
      }
      if (!admin) {
        // The saved session may be read-only even on a connection with operator.write.
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
          break;
        }
      }
      otherCurrent = cached?.isCurrent ?? owner.isCurrent;
      break;
    }
  }
  return () => {
    const current = observed();
    const saved = store.profiles[profileId];
    if (
      !owner.isCurrent() ||
      current?.profileId !== profileId ||
      current.accountId !== active.accountId ||
      current.userId !== active.userId ||
      saved?.provider !== row.provider ||
      saved.type !== "oauth" ||
      saved.accountId !== current.accountId ||
      resolveOpenAICodexAuthIdentity(saved).userId !== current.userId
    ) {
      return result.models;
    }
    let label: string | null = null;
    if (otherCurrent?.()) {
      const identity = admin
        ? resolveAuthProfileMetadata({ cfg: owner.config, store, profileId })
        : undefined;
      const ordinal = sharedModelAccountOrdinals(store, row.provider)?.get(profileId);
      label =
        identity?.displayName ??
        identity?.email ??
        (ordinal ? `Shared account ${ordinal}` : "Shared account");
    }
    const updated = { ...row };
    if (alternate) {
      const labeled = { ...alternate, codexAccountLabel: label };
      updated.runtimeChoices = row.runtimeChoices?.map((option) =>
        option === alternate ? labeled : option,
      );
    } else {
      updated.codexAccountLabel = label;
    }
    return result.models.map((model) => (model === row ? updated : model));
  };
}
