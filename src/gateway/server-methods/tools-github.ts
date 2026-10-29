import {
  ErrorCodes,
  errorShape,
  validateToolsGitHubAuthorizeCancelParams,
  validateToolsGitHubAuthorizePollParams,
  validateToolsGitHubAuthorizeStartParams,
  validateToolsGitHubConfigureParams,
  validateToolsGitHubStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  GitHubIdentityError,
  createManagedGitHubProfileId,
  installManagedGitHubProfile,
  resolveConfiguredGitHubToolIdentity,
  resolveGitHubToolIdentityStatus,
  resolveManagedGitHubProfileDir,
} from "../../agents/github-tool-identity.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { capturePluginLifecycleAuthority } from "../../plugins/registry-lifecycle.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../../secrets/runtime-state.js";
import { consumeGitHubSetupHandoff } from "../../secrets/store/secret-store.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { GitHubCliUnavailableError } from "../github-cli-preflight.js";
import { gitHubPublicApi } from "../github-public-api.js";
import { prepareGitHubReaderIdentity } from "../github-reader-identity.js";
import { updateGitHubToolIdentityConfig } from "../github-tool-identity-config.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import { respondError } from "./response.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

const handleGitHubRead: GatewayRequestHandler = async (options) => {
  const { params, respond, context, client, req } = options;
  const searching = req.method === "tools.github.search";
  const toolName = searching ? "github_search" : "github_read";
  const operation = searching
    ? ({ type: "search", params: gitHubPublicApi.parseGitHubSearchParams(params) } as const)
    : ({ type: "read", params: gitHubPublicApi.parseGitHubReadTarget(params) } as const);
  if (
    !operation.params ||
    params.agentId !== undefined ||
    params.sessionKey !== undefined ||
    (params.refresh !== undefined && typeof params.refresh !== "boolean")
  ) {
    respondError(respond, ErrorCodes.INVALID_REQUEST, `invalid ${req.method} params`);
    return;
  }
  const caller = client?.internal?.syntheticClient ? getGatewayToolCallerIdentity() : undefined;
  const assertCaller = caller && captureGatewayToolCallerAssertion();
  const assertToolAllowed = caller?.assertToolAllowed;
  const scope = getPluginRuntimeGatewayRequestScope();
  const registry = scope?.pluginRegistry;
  const record = registry?.plugins.find((plugin) => plugin.id === "github");
  const pluginCurrent =
    registry &&
    record &&
    capturePluginLifecycleAuthority(registry, record, { scopedRuntime: true });
  if (
    !caller ||
    !assertCaller ||
    !assertToolAllowed ||
    client?.internal?.pluginRuntimeOwnerId !== "github" ||
    !pluginCurrent
  ) {
    respondError(
      respond,
      ErrorCodes.INVALID_REQUEST,
      `GitHub reading requires an active ${toolName} tool invocation.`,
    );
    return;
  }
  const signals = [options.signal, getAsyncWorkSignal(), ...(caller.approvalSignals ?? [])].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const signal = AbortSignal.any(signals);
  const assertActive = () => {
    assertCaller();
    assertToolAllowed(toolName);
    options.sessionMutationCommitGuard?.();
    signal.throwIfAborted();
    if (!pluginCurrent() || options.hasCurrentClientAuthority?.() === false) {
      throw new Error("GitHub read authority is no longer active.");
    }
  };
  try {
    const { identity, assertSelected } = await prepareGitHubReaderIdentity(
      context,
      caller.agentId,
      assertActive,
    );
    const document =
      operation.type === "read"
        ? await gitHubPublicApi.loadGitHubDetail(
            operation.params,
            identity,
            undefined,
            params.refresh === true,
            { assertActive: assertSelected, signal },
          )
        : await gitHubPublicApi.searchPublicGitHubItems(operation.params, identity, undefined, {
            assertActive: assertSelected,
            signal,
          });
    assertSelected();
    respond(true, document, undefined);
  } catch (error) {
    const { message, ...details } =
      error instanceof GitHubIdentityError
        ? { message: error.message, retryable: error.reason !== "unavailable" }
        : gitHubPublicApi.formatControlUiGitHubPreviewError(error);
    respondError(respond, ErrorCodes.UNAVAILABLE, message, details);
  }
};

export const toolsGitHubHandlers: GatewayRequestHandlers = {
  "tools.github.read": handleGitHubRead,
  "tools.github.search": handleGitHubRead,
  "tools.github.status": defineValidatedGatewayHandler(
    "tools.github.status",
    validateToolsGitHubStatusParams,
    async ({ params, respond, context }) => {
      const resolved = resolveAgentIdOrRespondError({
        rawAgentId: params.agentId,
        respond,
        cfg: context.getRuntimeConfig(),
      });
      if (!resolved) {
        return;
      }
      respond(
        true,
        await resolveGitHubToolIdentityStatus({
          config: resolved.cfg,
          sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? resolved.cfg,
          agentId: resolved.agentId,
          selectedScope: params.selectedScope,
        }),
      );
    },
  ),
  "tools.github.configure": defineValidatedGatewayHandler(
    "tools.github.configure",
    validateToolsGitHubConfigureParams,
    async ({ params, respond, context }) => {
      const resolved = resolveAgentIdOrRespondError({
        rawAgentId: params.agentId,
        respond,
        cfg: context.getRuntimeConfig(),
      });
      if (!resolved) {
        return;
      }
      try {
        const previousIdentity = resolveConfiguredGitHubToolIdentity({
          config: resolved.cfg,
          agentId: resolved.agentId,
          scope: params.scope,
        });
        let nextConfig = resolved.cfg;
        if (params.mode === "inherit") {
          nextConfig = await updateGitHubToolIdentityConfig({
            scope: params.scope,
            agentId: resolved.agentId,
            expectedIdentity: previousIdentity ?? null,
          });
        } else {
          const gitAuthor = params.gitAuthor
            ? {
                ...(params.gitAuthor.name !== undefined
                  ? { name: params.gitAuthor.name.trim() }
                  : {}),
                ...(params.gitAuthor.email !== undefined
                  ? { email: params.gitAuthor.email.trim() }
                  : {}),
              }
            : undefined;
          const token = await consumeGitHubSetupHandoff({ name: params.secretName });
          if (!token) {
            throw new Error("temporary GitHub credential is unavailable");
          }
          const profileId = createManagedGitHubProfileId();
          const profileDir = resolveManagedGitHubProfileDir({
            agentId: resolved.agentId,
            scope: params.scope,
            profileId,
          });
          await installManagedGitHubProfile({
            profileDir,
            token,
            commitConfig: async (account) => {
              const identity = {
                profileId,
                gitAuthor: gitAuthor ?? {
                  name: account.login,
                  email: `${account.accountId}+${account.login}@users.noreply.github.com`,
                },
              };
              nextConfig = await updateGitHubToolIdentityConfig({
                scope: params.scope,
                agentId: resolved.agentId,
                identity,
                expectedIdentity: previousIdentity ?? null,
              });
            },
          });
        }
        if (previousIdentity?.kind === "oauth") {
          await context.githubOAuthService?.retireProfileAsync(previousIdentity.profileId);
        }
        respond(
          true,
          await resolveGitHubToolIdentityStatus({
            config: nextConfig,
            agentId: resolved.agentId,
            selectedScope: params.scope,
          }),
        );
      } catch {
        respondError(respond, ErrorCodes.UNAVAILABLE, "GitHub identity setup failed");
      }
    },
  ),
  "tools.github.authorize.start": defineValidatedGatewayHandler(
    "tools.github.authorize.start",
    validateToolsGitHubAuthorizeStartParams,
    async ({ params, respond, context }) => {
      const resolved = resolveAgentIdOrRespondError({
        rawAgentId: params.agentId,
        respond,
        cfg: context.getRuntimeConfig(),
      });
      if (!resolved) {
        return;
      }
      try {
        const service = context.githubOAuthService;
        if (!service) {
          throw new Error("GitHub authorization lifecycle is unavailable.");
        }
        respond(
          true,
          await service.startAuthorization({ scope: params.scope, agentId: resolved.agentId }),
        );
      } catch (error) {
        respondError(
          respond,
          ErrorCodes.UNAVAILABLE,
          error instanceof GitHubCliUnavailableError
            ? error.message
            : "GitHub authorization could not start",
        );
      }
    },
  ),
  "tools.github.authorize.poll": defineValidatedGatewayHandler(
    "tools.github.authorize.poll",
    validateToolsGitHubAuthorizePollParams,
    async ({ params, respond, context }) => {
      const service = context.githubOAuthService;
      if (!service) {
        throw new Error("GitHub authorization lifecycle is unavailable.");
      }
      respond(true, await service.pollAuthorization(params.requestId));
    },
    () => errorShape(ErrorCodes.UNAVAILABLE, "GitHub authorization polling failed"),
  ),
  "tools.github.authorize.cancel": defineValidatedGatewayHandler(
    "tools.github.authorize.cancel",
    validateToolsGitHubAuthorizeCancelParams,
    async ({ params, respond, context }) => {
      const service = context.githubOAuthService;
      if (!service) {
        respondError(
          respond,
          ErrorCodes.UNAVAILABLE,
          "GitHub authorization lifecycle is unavailable",
        );
        return;
      }
      respond(true, { cancelled: await service.cancelAuthorizationAsync(params.requestId) });
    },
  ),
};
