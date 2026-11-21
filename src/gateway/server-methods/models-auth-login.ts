import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  ErrorCodes,
  errorShape,
  validateSystemAgentSetupAuthStartParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveNativeModelPrimary } from "../../agents/agent-scope-config.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { runModelsAuthLoginFlowForGateway } from "../../commands/models/auth.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveManifestDeclaredProviderAuthChoices } from "../../plugins/provider-auth-choices.js";
import {
  formatProviderLoginChoiceRef,
  isProviderCliLoginChoiceStartable,
  isProviderLoginChoiceStartable,
} from "../../plugins/provider-login-options.js";
import { createNonExitingRuntime } from "../../runtime.js";
import { ProviderCredentialsSavedError } from "../../shared/provider-auth-result.js";
import { toSavedAuthSetupKind } from "../../system-agent/setup-inference-core.js";
import { WizardSession } from "../../wizard/session.js";
import { refreshModelAuthStateAfterMutation } from "../model-auth-refresh.js";
import { createProviderBrowserAuthSession } from "../provider-browser-auth.js";
import {
  captureLocalStateMutationGuard,
  localStateOwnerChangedError,
} from "./local-state-owner.js";
import { buildModelsListResult } from "./models-list-result.js";
import { startGatewayWizard } from "./setup-admission.js";
import { resolveSystemAgentSessionOwnerKey } from "./system-agent-session-owner.js";
import { runSetupActivation, startSetupActivationWizard } from "./system-agent-setup-wizard.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

export const modelsAuthLoginHandlers: GatewayRequestHandlers = {
  "models.authLogin": defineValidatedGatewayHandler(
    "models.authLogin",
    validateSystemAgentSetupAuthStartParams,
    async (options) => {
      const { params, respond, context, client } = options;
      if (!client || !client.connect.scopes?.includes("operator.admin")) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "Provider login requires an administrator connection.",
          ),
        );
        return;
      }
      let assertOwner: (() => void) | undefined;
      if (params.expectedOwnerId) {
        try {
          // A wizard publishes its own config changes; bind each effect to the
          // same physical owner without pinning the pre-login config snapshot.
          const expectedOwnerId = params.expectedOwnerId;
          assertOwner = () => captureLocalStateMutationGuard(expectedOwnerId, options)();
          assertOwner();
        } catch (error) {
          respond(false, undefined, localStateOwnerChangedError(error));
          return;
        }
      }
      const resolveChoice = () => {
        const matches = resolveManifestDeclaredProviderAuthChoices({
          config: context.getRuntimeConfig(),
          includeUntrustedWorkspacePlugins: false,
          includeWorkspacePlugins: false,
        }).filter((entry) => formatProviderLoginChoiceRef(entry) === params.authChoice);
        return matches.length === 1 ? matches[0] : undefined;
      };
      const isStartable = params.expectedOwnerId
        ? isProviderCliLoginChoiceStartable
        : isProviderLoginChoiceStartable;
      const choice = resolveChoice();
      if (!choice || !isStartable(choice)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "That provider login is no longer available. Refresh Models and choose an available sign-in option.",
          ),
        );
        return;
      }
      const assertLoginCurrent = () => {
        assertOwner?.();
        if (client.invalidated || !client.connect.scopes?.includes("operator.admin")) {
          throw new Error("Provider login authority is no longer active.");
        }
        const current = resolveChoice();
        if (
          !current ||
          !isStartable(current) ||
          current.pluginId !== choice.pluginId ||
          current.providerId !== choice.providerId ||
          current.methodId !== choice.methodId
        ) {
          throw new Error("That provider login is no longer available.");
        }
      };
      // An agent without a chosen model gets this account's recommended model (else its
      // first available one), verified and selected by the saved-sign-in activation owner.
      // A primary set by the operator, before or during sign-in, is never replaced.
      const resolveFirstModel = async (profileId: string) => {
        const config = context.getRuntimeConfig();
        const agentId = params.agentId ?? resolveDefaultAgentId(config);
        if (resolveNativeModelPrimary(config, agentId)) {
          return undefined;
        }
        const provider = normalizeProviderId(choice.providerId);
        const { models } = await buildModelsListResult({
          source: { kind: "gateway", context },
          agentId,
          // Discover the new account's own catalog before choosing from it.
          params: { agentId, provider: choice.providerId, refresh: true },
        });
        const usable = models.filter(
          (model) =>
            normalizeProviderId(model.provider) === provider &&
            model.available === true &&
            model.manualSelectionAllowed !== false,
        );
        const model = usable.find((entry) => entry.recommended === true) ?? usable[0];
        if (!model) {
          context.logGateway.info(
            `${choice.choiceLabel}: sign-in saved; the account lists no available model to select`,
          );
        }
        return model
          ? {
              name: model.name,
              activation: {
                kind: toSavedAuthSetupKind(profileId),
                ...(params.agentId ? { agentId: params.agentId } : {}),
                modelRef: model.id.startsWith(`${model.provider}/`)
                  ? model.id
                  : `${model.provider}/${model.id}`,
                selectModel: true,
              },
            }
          : undefined;
      };
      if (choice.appGuidedAuth && choice.credentialOnly !== true) {
        await startSetupActivationWizard({
          request: options,
          sessionId: params.sessionId,
          ownerKey: resolveSystemAgentSessionOwnerKey({ client }),
          connectionBound: true,
          isLocalClient: client.internal?.isLocalClient === true,
          assertCurrent: assertLoginCurrent,
          activation: {
            kind: "provider-auth",
            authChoice: choice.choiceId,
            agentId: params.agentId,
            selectModel: params.selectModel === true,
          },
          timeoutMs: 25 * 60_000,
        });
        return;
      }
      await startGatewayWizard({
        request: options,
        sessionId: params.sessionId,
        connectionBound: true,
        assertCurrent: assertLoginCurrent,
        createSession: (assertCurrent) =>
          new WizardSession(
            async (prompter, signal, runner) => {
              const runtime = createNonExitingRuntime();
              const openUrl = async (url: string) => {
                assertFlowCurrent();
                await prompter.openUrl?.(url);
                assertFlowCurrent();
              };
              const browser = client.browserOrigin
                ? createProviderBrowserAuthSession({
                    signal,
                    openUrl,
                    browserOrigin: client.browserOrigin,
                    authPolicy: client.authPolicy,
                  })
                : undefined;
              const assertFlowCurrent = () => {
                signal.throwIfAborted();
                assertCurrent();
                browser?.assertCurrent();
              };
              let result: Awaited<ReturnType<typeof runModelsAuthLoginFlowForGateway>>;
              try {
                result = await runModelsAuthLoginFlowForGateway({
                  provider: choice.providerId,
                  method: choice.methodId,
                  ownerPluginId: choice.pluginId,
                  credentialOnly: true,
                  agent: params.agentId,
                  config: context.getRuntimeConfig(),
                  runtime,
                  prompter,
                  signal: browser?.signal ?? signal,
                  isRemote: !params.expectedOwnerId,
                  openUrl,
                  browserAuthorization: browser?.available ? browser.authorize : undefined,
                  assertCurrent: assertFlowCurrent,
                  beforePersistentEffect: () => {
                    assertFlowCurrent();
                    runner.lockCancellationForPreparation();
                  },
                  refreshAfterLogin: (agentId) =>
                    refreshModelAuthStateAfterMutation(context.getRuntimeConfig, agentId),
                });
                if (result.profiles.length === 0) {
                  throw new Error(`${choice.choiceLabel} did not return a credential profile.`);
                }
              } finally {
                browser?.close();
              }
              if (result.modelAccess && !result.modelAccess.applied) {
                throw new ProviderCredentialsSavedError(
                  "Your sign-in and model access were saved, but OpenClaw has not confirmed that model access is active. Close this dialog. Open Settings and select Apply changes, then send /models.",
                );
              }
              if (result.authRefresh !== "refreshed") {
                throw new ProviderCredentialsSavedError(
                  "Your sign-in was saved, but the connection update could not be confirmed. Send /login refresh in chat to try again.",
                );
              }
              const profileId = result.profiles[0]?.profileId;
              const first =
                params.selectModel === true && profileId
                  ? await resolveFirstModel(profileId)
                  : undefined;
              if (first) {
                try {
                  await runSetupActivation({
                    activation: first.activation,
                    isLocalClient: client.internal?.isLocalClient === true,
                    prompter,
                    signal,
                    runnerSession: runner,
                    // The browser callback closed with sign-in; activation needs only the session.
                    assertCurrent,
                  });
                } catch (error) {
                  signal.throwIfAborted();
                  throw new ProviderCredentialsSavedError(
                    `Your sign-in was saved, but ${first.name} could not be set up for this agent: ${formatErrorMessage(error)} Choose a model in Settings → Models.`,
                    { cause: error },
                  );
                }
              }
            },
            { timeoutMs: 25 * 60_000 },
          ),
      });
    },
  ),
};
