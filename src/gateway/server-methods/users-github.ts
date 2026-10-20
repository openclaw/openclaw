import {
  ErrorCodes,
  errorShape,
  validateUsersGitHubStatusParams,
  validateUsersGitHubAuthorizeStartParams,
  validateUsersGitHubAuthorizePollParams,
  validateUsersGitHubAuthorizeCancelParams,
  validateUsersGitHubDisconnectParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSystemGitHubIdentityStatus } from "../../agents/github-tool-identity.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../../secrets/runtime-state.js";
import type { PersonalGitHubAction } from "../github-personal-oauth.js";
import { preparePersonalGitHubActionV2 } from "./github-personal-authorization.js";
import type {
  GatewayRequestHandlers,
  GatewayRequestHandlerOptions,
  GatewayRequestContext,
} from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

async function runPersonalGitHub(
  options: Pick<GatewayRequestHandlerOptions, "client" | "context" | "signal" | "respond">,
  fallbackError: string,
  run: (
    action: PersonalGitHubAction,
    service: NonNullable<GatewayRequestContext["githubOAuthService"]>["personal"],
  ) => unknown,
): Promise<void> {
  const fail = (error: unknown) =>
    options.respond(
      false,
      undefined,
      errorShape(ErrorCodes.FORBIDDEN, error instanceof Error ? error.message : fallbackError),
    );
  try {
    const action = await preparePersonalGitHubActionV2(options);
    const service = options.context.githubOAuthService?.personal;
    if (!service) {
      throw new Error("GitHub connections are unavailable; retry after Gateway startup.");
    }
    const result = await run(action, service);
    action.assertCurrent();
    options.respond(true, result);
  } catch (error) {
    fail(error);
  }
}

export const usersGitHubHandlers: GatewayRequestHandlers = {
  "users.github.status": defineValidatedGatewayMethod(
    "users.github.status",
    validateUsersGitHubStatusParams,
    (options) =>
      runPersonalGitHub(options, "My GitHub is unavailable.", async (action, service) => {
        const config = options.context.getRuntimeConfig();
        const system = await resolveSystemGitHubIdentityStatus({
          config,
          sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? config,
        });
        const personal = await service.status(action);
        return { personal, system };
      }),
  ),
  "users.github.authorize.start": defineValidatedGatewayMethod(
    "users.github.authorize.start",
    validateUsersGitHubAuthorizeStartParams,
    (options) =>
      runPersonalGitHub(options, "My GitHub authorization failed.", (action, service) =>
        service.startAuthorization(action),
      ),
  ),
  "users.github.authorize.poll": defineValidatedGatewayMethod(
    "users.github.authorize.poll",
    validateUsersGitHubAuthorizePollParams,
    (options) =>
      runPersonalGitHub(options, "My GitHub authorization failed.", (action, service) =>
        service.pollAuthorization(action, options.params.requestId),
      ),
  ),
  "users.github.authorize.cancel": defineValidatedGatewayMethod(
    "users.github.authorize.cancel",
    validateUsersGitHubAuthorizeCancelParams,
    (options) =>
      runPersonalGitHub(options, "My GitHub authorization failed.", async (action, service) => ({
        cancelled: await service.cancelAuthorizationAsync(action, options.params.requestId),
      })),
  ),
  "users.github.disconnect": defineValidatedGatewayMethod(
    "users.github.disconnect",
    validateUsersGitHubDisconnectParams,
    (options) =>
      runPersonalGitHub(options, "My GitHub disconnect failed.", async (action, service) => {
        await service.disconnectAsync(action);
        return { disconnected: true };
      }),
  ),
};
