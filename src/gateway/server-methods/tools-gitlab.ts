import {
  ErrorCodes,
  errorShape,
  validateToolsGitLabStatusParams,
  validateToolsGitLabConfigureParams,
  validateToolsGitLabAuthorizeStartParams,
  validateToolsGitLabAuthorizeCompleteParams,
  validateToolsGitLabAuthorizeCancelParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { captureAgentLifecycleBinding } from "../../agents/agent-lifecycle-registry.js";
import { retireManagedGitLabProfile } from "../../agents/gitlab-tool-identity.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import { preparePersonalForgeAction } from "./personal-forge-authorization.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

async function managed<T>(
  options: GatewayRequestHandlerOptions,
  scope: "operator.read" | "operator.admin",
  run: (
    action: Awaited<ReturnType<typeof preparePersonalForgeAction>>,
    service: NonNullable<GatewayRequestHandlerOptions["context"]["gitlabManagedOAuthService"]>,
  ) => Promise<T>,
) {
  try {
    const action = await preparePersonalForgeAction(options, scope, undefined, "GitLab");
    const service = options.context.gitlabManagedOAuthService;
    if (!service) {
      throw new Error("GitLab connection management is unavailable.");
    }
    const result = await run(action, service);
    action.assertCurrent();
    options.respond(true, result);
  } catch {
    options.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        "GitLab connection management could not complete. Check the selected account and try again.",
      ),
    );
  }
}

export const toolsGitLabHandlers: GatewayRequestHandlers = {
  "tools.gitlab.status": defineValidatedGatewayMethod(
    "tools.gitlab.status",
    validateToolsGitLabStatusParams,
    async (options) => {
      if (!options.context.getRuntimeConfig().gateway?.gitlab) {
        options.respond(true, { configured: false });
        return;
      }
      const target = resolveAgentIdOrRespondError({
        rawAgentId: options.params.agentId,
        cfg: options.context.getRuntimeConfig(),
        respond: options.respond,
      });
      if (!target) {
        return;
      }
      await managed(options, "operator.read", async (action, service) => {
        const status = await service.status(
          { scope: options.params.selectedScope ?? "agent", agentId: target.agentId },
          action.assertCurrent,
        );
        const project = (selected: typeof status.selected) =>
          selected
            ? {
                ...selected,
                account: selected.account
                  ? { accountId: selected.account.accountId, login: selected.account.login }
                  : null,
              }
            : null;
        return {
          configured: true,
          ...status,
          selected: project(status.selected),
          effective: project(status.effective),
        };
      });
    },
  ),
  "tools.gitlab.authorize.start": defineValidatedGatewayMethod(
    "tools.gitlab.authorize.start",
    validateToolsGitLabAuthorizeStartParams,
    async (options) => {
      const target = resolveAgentIdOrRespondError({
        rawAgentId: options.params.agentId,
        cfg: options.context.getRuntimeConfig(),
        respond: options.respond,
      });
      if (!target) {
        return;
      }
      await managed(options, "operator.admin", (action, service) =>
        service.start(action, { scope: options.params.scope, agentId: target.agentId }),
      );
    },
  ),
  "tools.gitlab.authorize.complete": defineValidatedGatewayMethod(
    "tools.gitlab.authorize.complete",
    validateToolsGitLabAuthorizeCompleteParams,
    (options) =>
      managed(options, "operator.admin", (action, service) =>
        service.complete(action, options.params.requestId, options.params.callbackUrl),
      ),
  ),
  "tools.gitlab.authorize.cancel": defineValidatedGatewayMethod(
    "tools.gitlab.authorize.cancel",
    validateToolsGitLabAuthorizeCancelParams,
    (options) =>
      managed(options, "operator.admin", (action, service) =>
        service.cancel(action, options.params.requestId),
      ),
  ),
  "tools.gitlab.configure": defineValidatedGatewayMethod(
    "tools.gitlab.configure",
    validateToolsGitLabConfigureParams,
    async (options) => {
      const target = resolveAgentIdOrRespondError({
        rawAgentId: options.params.agentId,
        cfg: options.context.getRuntimeConfig(),
        respond: options.respond,
      });
      if (!target) {
        return;
      }
      await managed(options, "operator.admin", async (action, service) => {
        const binding =
          options.params.scope === "agent"
            ? await captureAgentLifecycleBinding(options.context.getRuntimeConfig, target.agentId)
            : undefined;
        if (options.params.scope === "agent" && !binding) {
          throw new Error("Agent is unavailable.");
        }
        await retireManagedGitLabProfile({
          config: options.context.getRuntimeConfig(),
          getCurrentConfig: options.context.getRuntimeConfig,
          agentId: target.agentId,
          scope: options.params.scope,
          agentLifecycleBinding: binding,
          assertCurrent: action.assertCurrent,
        });
        await service.reconcile();
        return { configured: false, scope: options.params.scope, agentId: target.agentId };
      });
    },
  ),
};
