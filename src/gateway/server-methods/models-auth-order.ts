import {
  ErrorCodes,
  errorShape,
  validateModelsAuthOrderSetParams,
  validateModelsAuthProfileRenameParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  resolveExplicitAuthOrderSelection,
  setAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import {
  resolveAuthProfileDisplayNameTarget,
  setAuthProfileDisplayName,
} from "../../agents/auth-profiles/display-name.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { refreshModelAuthStateAfterMutation } from "../model-auth-refresh.js";
import { readPreparedCatalog } from "../server-model-catalog-auth.js";
import { formatForLog } from "../ws-log.js";
import { resolveModelAuthAgentScope } from "./model-auth-agent-scope.js";
import { resolveConfigBoundProfileIds } from "./models-auth-status-config.js";
import type {
  ModelAuthOrderSetResult,
  ModelAuthProfileRenameResult,
} from "./models-auth-status.types.js";
import { respondUnavailableOnThrow } from "./response.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

const log = createSubsystemLogger("models-auth-order");

export const modelsAuthOrderHandlers: GatewayRequestHandlers = {
  "models.authProfileRename": defineValidatedGatewayHandler(
    "models.authProfileRename",
    validateModelsAuthProfileRenameParams,
    async ({ params, context, respond }) => {
      await respondUnavailableOnThrow(respond, async () => {
        const scope = resolveModelAuthAgentScope(context.getRuntimeConfig(), params.agentId);
        if (!scope.ok) {
          respond(false, undefined, scope.error);
          return;
        }
        const snapshot = await readPreparedCatalog(context, scope.agentId);
        if (!snapshot) {
          throw new Error("Prepared model auth owner is unavailable");
        }
        const { profileId } = params;
        const { authStore: store, config: cfg, agentDir } = snapshot;
        const configBound = resolveConfigBoundProfileIds(cfg, store, {
          config: cfg,
          workspaceDir: snapshot.workspaceDir,
          metadataSnapshot: snapshot.metadataSnapshot,
          includeUntrustedWorkspacePlugins: false,
        }).has(profileId);
        const target = resolveAuthProfileDisplayNameTarget({
          cfg,
          store,
          agentDir,
          profileId,
          configBound,
        });
        const reject = (message: string) =>
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
        if (target !== "local" && target !== "shared") {
          reject(
            target === "config"
              ? "Account name is managed in configuration"
              : "Account name is not editable for this agent",
          );
          return;
        }
        const displayName = params.displayName.trim() || null;
        const outcome = await setAuthProfileDisplayName({
          agentDir: target === "local" ? agentDir : undefined,
          profileId,
          displayName,
          preserveStateProfileIds: Object.keys(store.profiles),
        });
        if (outcome === "unwritable") {
          reject("Account name is not editable for this agent");
          return;
        }
        if (outcome === "unavailable") {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, "Unable to save the account name"),
          );
          return;
        }
        const result: ModelAuthProfileRenameResult = { profileId, displayName };
        try {
          await refreshModelAuthStateAfterMutation(context.getRuntimeConfig, scope.agentId);
        } catch (err) {
          log.warn("auth profile name saved but runtime publication failed: " + formatForLog(err));
          result.warning = "Account name saved. Live status is unavailable; refresh Models.";
        }
        respond(true, result, undefined);
      });
    },
  ),
  "models.authOrderSet": defineValidatedGatewayHandler(
    "models.authOrderSet",
    validateModelsAuthOrderSetParams,
    async ({ params, respond, context }) => {
      const provider = params.provider;
      const profileIds = params.profileIds ?? null;
      const rejectInvalidOrder = (message: string) =>
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
      await respondUnavailableOnThrow(respond, async () => {
        const cfg = context.getRuntimeConfig();
        const scope = resolveModelAuthAgentScope(cfg, params.agentId);
        if (!scope.ok) {
          respond(false, undefined, scope.error);
          return;
        }
        const preparedSnapshot = await readPreparedCatalog(context, scope.agentId);
        if (!preparedSnapshot) {
          throw new Error(`prepared model auth owner is unavailable (${scope.agentId})`);
        }
        const authAliasLookupParams = {
          config: preparedSnapshot.config,
          workspaceDir: preparedSnapshot.workspaceDir,
          metadataSnapshot: preparedSnapshot.metadataSnapshot,
          includeUntrustedWorkspacePlugins: false,
        };
        const authProvider = resolveProviderIdForAuth(provider, authAliasLookupParams);
        const configuredOrder = resolveExplicitAuthOrderSelection({
          storeOrder: preparedSnapshot.authStore.order,
          configuredOrder: preparedSnapshot.config.auth?.order,
          providerKey: provider,
          providerAuthKey: authProvider,
        });
        if (profileIds && configuredOrder.order !== undefined && !configuredOrder.fromStore) {
          rejectInvalidOrder(
            `profile priority for provider ${provider} is controlled by auth configuration`,
          );
          return;
        }
        const availableProfileIds = Object.entries(preparedSnapshot.authStore.profiles)
          .filter(
            ([, credential]) =>
              resolveProviderIdForAuth(credential.provider, {
                ...authAliasLookupParams,
                storedCredential: true,
              }) === authProvider,
          )
          .map(([profileId]) => profileId);
        const configBoundProfileIds = resolveConfigBoundProfileIds(
          preparedSnapshot.config,
          preparedSnapshot.authStore,
          authAliasLookupParams,
        );
        if (
          profileIds &&
          availableProfileIds.some((profileId) => configBoundProfileIds.has(profileId))
        ) {
          rejectInvalidOrder(
            `profile priority for provider ${provider} is controlled by provider configuration`,
          );
          return;
        }
        const invalidProfile = profileIds?.find(
          (profileId) => !availableProfileIds.includes(profileId),
        );
        if (invalidProfile) {
          rejectInvalidOrder(`profileId ${invalidProfile} is unavailable for provider ${provider}`);
          return;
        }
        if (profileIds && profileIds.length !== availableProfileIds.length) {
          rejectInvalidOrder(
            `profileIds must include every available profile for provider ${provider}`,
          );
          return;
        }
        const updated = await setAuthProfileOrder({
          agentDir: preparedSnapshot.agentDir,
          provider: authProvider,
          order: profileIds,
        });
        if (!updated) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, "auth profile order is temporarily unavailable"),
          );
          return;
        }
        const result: ModelAuthOrderSetResult = { provider, profileIds };
        // The store already started auth publication. Await that owner so immediate status
        // is current, but do not report a committed write as failed if publication rejects.
        try {
          await refreshModelAuthStateAfterMutation(context.getRuntimeConfig, scope.agentId);
        } catch (err) {
          log.warn(`auth profile order saved but runtime publication failed: ${formatForLog(err)}`);
          result.warning =
            "Profile priority saved. Live status is unavailable; refresh Models or restart the Gateway.";
        }
        respond(true, result, undefined);
      });
    },
  ),
};
