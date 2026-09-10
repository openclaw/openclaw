import {
  ErrorCodes,
  errorShape,
  validateSystemAgentSetupAuthStartParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { runModelsAuthLoginFlowCore } from "../../commands/models/auth.js";
import { resolveManifestDeclaredProviderAuthChoices } from "../../plugins/provider-auth-choices.js";
import {
  formatProviderLoginChoiceRef,
  isProviderLoginChoiceStartable,
} from "../../plugins/provider-login-options.js";
import { createNonExitingRuntime } from "../../runtime.js";
import { WizardSession } from "../../wizard/session.js";
import { createProviderBrowserAuthSession } from "../provider-browser-auth.js";
import { bindWizardLoginOwner } from "../server-wizard-sessions.js";
import { getTailscalePublishedOrigin } from "../tailscale-published-origin.js";
import { refreshModelAuthStateAfterMutation } from "./models-auth-refresh.js";
import {
  createAdmittedWizardSession,
  respondSetupAdmissionBusy,
  whenAdmittedWizardSessionSettled,
} from "./setup-admission.js";
import { rejectExistingSetupWizardSession } from "./system-agent-setup-wizard.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const modelsAuthLoginHandlers: GatewayRequestHandlers = {
  "models.authLogin": async ({ params, respond, context, client }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentSetupAuthStartParams,
        "models.authLogin",
        respond,
      )
    ) {
      return;
    }
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
    if (rejectExistingSetupWizardSession({ sessionId: params.sessionId, context, respond })) {
      return;
    }
    const resolveChoice = () => {
      const matches = resolveManifestDeclaredProviderAuthChoices({
        config: context.getRuntimeConfig(),
        includeUntrustedWorkspacePlugins: false,
        includeWorkspacePlugins: false,
      }).filter((entry) => formatProviderLoginChoiceRef(entry) === params.authChoice);
      return matches.length === 1 ? matches[0] : undefined;
    };
    const choice = resolveChoice();
    if (!choice || !isProviderLoginChoiceStartable(choice)) {
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
    const assertCurrent = () => {
      client.connectionSignal?.throwIfAborted();
      if (client.invalidated || !client.connect.scopes?.includes("operator.admin")) {
        throw new Error("Provider login authority is no longer active.");
      }
      const current = resolveChoice();
      if (
        !current ||
        !isProviderLoginChoiceStartable(current) ||
        current.pluginId !== choice.pluginId ||
        current.providerId !== choice.providerId ||
        current.methodId !== choice.methodId
      ) {
        throw new Error("That provider login is no longer available.");
      }
    };
    const session = await createAdmittedWizardSession(() => {
      assertCurrent();
      return new WizardSession(
        async (prompter, signal, runner) => {
          const openUrl = async (url: string) => {
            assertFlowCurrent();
            await prompter.openUrl?.(url);
            assertFlowCurrent();
          };
          const published = getTailscalePublishedOrigin();
          const browser =
            published && client.browserOrigin?.origin === published.origin
              ? createProviderBrowserAuthSession({
                  signal: AbortSignal.any([signal, published.signal]),
                  openUrl,
                })
              : undefined;
          const assertFlowCurrent = () => {
            signal.throwIfAborted();
            assertCurrent();
            browser?.assertCurrent();
          };
          try {
            const result = await runModelsAuthLoginFlowCore({
              provider: choice.providerId,
              method: choice.methodId,
              ownerPluginId: choice.pluginId,
              credentialOnly: true,
              agent: params.agentId,
              config: context.getRuntimeConfig(),
              runtime: createNonExitingRuntime(),
              prompter,
              signal: browser?.signal ?? signal,
              isRemote: true,
              openUrl,
              browserAuthorization: browser?.authorize,
              assertCurrent: assertFlowCurrent,
              beforePersistentEffect: () => {
                assertFlowCurrent();
                runner.lockCancellation();
              },
              refreshAfterLogin: (agentId) =>
                refreshModelAuthStateAfterMutation(context, "login", agentId),
            });
            if (result.profiles.length === 0) {
              throw new Error(`${choice.choiceLabel} did not return a credential profile.`);
            }
          } finally {
            browser?.close();
          }
        },
        { timeoutMs: 25 * 60_000 },
      );
    });
    if (!session) {
      respondSetupAdmissionBusy(respond);
      return;
    }
    // Admission can yield. Never publish a late session for a disconnected owner.
    if (client.invalidated || client.connectionSignal?.aborted) {
      session.close(new Error("Provider login connection closed."));
      await whenAdmittedWizardSessionSettled(session);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Provider login connection closed."),
      );
      return;
    }
    bindWizardLoginOwner(session, client);
    context.wizardSessions.set(params.sessionId, session);
    const cancel = () => session.close(new Error("Provider login connection closed."));
    client.connectionSignal?.addEventListener("abort", cancel, { once: true });
    const settled = () => {
      client.connectionSignal?.removeEventListener("abort", cancel);
      if (client.connectionSignal?.aborted || client.invalidated) {
        context.purgeWizardSession(params.sessionId);
      }
    };
    void whenAdmittedWizardSessionSettled(session).then(settled, settled);
    respond(true, { sessionId: params.sessionId, done: false, status: "running" }, undefined);
  },
};
