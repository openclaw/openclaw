import { isDeepStrictEqual } from "node:util";
import {
  ErrorCodes,
  errorShape,
  validateMcpAuthLoginParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  mcpOAuthCliLoginSteps,
  operatorMcpOAuthIdentity,
} from "../../agents/mcp-oauth-identity.js";
import {
  completeOperatorMcpOAuthLink,
  startOperatorMcpOAuthLink,
} from "../../agents/mcp-oauth-link.js";
import {
  McpOAuthCredentialsRetainedError,
  type McpOAuthLoginLifecycle,
} from "../../agents/mcp-oauth-provider.js";
import {
  cancelMcpOAuthAuthorization,
  completeOAuthCallback,
  startMcpOAuthAuthorization,
} from "../../agents/mcp-oauth.js";
import { isTransientNetworkError } from "../../infra/retryable-network-errors.js";
import { getGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";
import { resolveOperatorMcpOAuthConnection } from "../../plugins/mcp-auth-status.js";
import {
  ProviderAuthFailure,
  readProviderAuthFailure,
} from "../../plugins/provider-auth-failure.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { WizardSession } from "../../wizard/session.js";
import { createProviderBrowserAuthSession } from "../provider-browser-auth.js";
import { startGatewayWizard } from "./setup-admission.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const mcpAuthLoginHandlers: GatewayRequestHandlers = {
  "mcp.authLogin": async (request) => {
    const { params, respond, context, client } = request;
    if (!assertValidParams(params, validateMcpAuthLoginParams, "mcp.authLogin", respond)) {
      return;
    }
    const reject = (message: string) =>
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
    if (!client || !client.connect.scopes?.includes("operator.admin")) {
      reject("Sign-in requires an administrator connection.");
      return;
    }
    const metadata = getGatewayPluginMetadataSnapshot();
    const resolveConnection = () =>
      resolveOperatorMcpOAuthConnection({
        config: context.getRuntimeConfig(),
        metadata,
        serverName: params.serverName,
      });
    const connection = resolveConnection();
    const methodRegistry = context.getGatewayMethodRegistry?.();
    const isOperatorOwned = () =>
      getGatewayPluginMetadataSnapshot() === metadata &&
      getPluginRuntimeGatewayRequestScope()?.pluginRegistry === methodRegistry?.pluginRegistry;
    if (!connection || !isOperatorOwned()) {
      reject(
        "sessionId" in params
          ? "This MCP server cannot use operator browser sign-in. Check its existing account settings."
          : "This MCP server has no shared OAuth sign-in. Check its name and OAuth settings; per-requester servers connect through the channel.",
      );
      return;
    }
    if (!("sessionId" in params)) {
      const input = {
        cfg: context.getRuntimeConfig(),
        metadata,
        serverName: params.serverName,
      };
      try {
        const result =
          params.callbackUrl === undefined
            ? await startOperatorMcpOAuthLink(input, connection)
            : {
                status: await completeOperatorMcpOAuthLink(
                  { ...input, callbackUrl: params.callbackUrl },
                  connection,
                ),
                serverName: params.serverName,
              };
        respond(true, result);
      } catch (error) {
        reject(
          error instanceof Error
            ? error.message
            : "MCP sign-in could not be completed. Try connecting again.",
        );
      }
      return;
    }
    const { config } = connection;
    const identity = operatorMcpOAuthIdentity(
      params.serverName,
      config.url,
      context.getRuntimeConfig(),
    );
    const terminalLogin = mcpOAuthCliLoginSteps(identity);
    const settingsOwner = identity.configured === false ? "plugin" : "MCP server";
    if (!client.browserOrigin) {
      reject(
        terminalLogin
          ? `Open Settings on this Gateway to sign in, or sign in from its terminal: ${terminalLogin}.`
          : "Open Settings on this Gateway to sign in.",
      );
      return;
    }
    const initialServer = structuredClone(connection.server);
    const assertServerCurrent = () => {
      if (
        context.getGatewayMethodRegistry?.() !== methodRegistry ||
        !isDeepStrictEqual(initialServer, resolveConnection()?.server) ||
        !isOperatorOwned()
      ) {
        throw new Error(
          "This MCP server changed. Close this dialog and review its settings before signing in again.",
        );
      }
    };
    await startGatewayWizard({
      request,
      sessionId: params.sessionId,
      connectionBound: true,
      assertCurrent: assertServerCurrent,
      createSession: (assertCurrent) =>
        new WizardSession(async (prompter, signal, runner) => {
          let attemptState: string | undefined;
          let saved = false;
          const browser = createProviderBrowserAuthSession({
            signal: AbortSignal.any([
              signal,
              ...(client.connectionSignal ? [client.connectionSignal] : []),
            ]),
            browserOrigin: client.browserOrigin,
            authPolicy: client.authPolicy,
            onRefusal: (failure) =>
              runner.pushProgress(failure.message, undefined, failure.message, failure.reason),
            openUrl: async (url) => {
              login.assertCurrent();
              await prompter.openUrl?.(url);
              login.assertCurrent();
            },
          });
          const login: McpOAuthLoginLifecycle = {
            signal: browser.signal,
            assertCurrent: () => {
              signal.throwIfAborted();
              assertCurrent();
              browser.assertCurrent();
            },
            onAuthorizationPublished: (state) => {
              attemptState = state;
            },
            beforeTokensSaved: () => runner.lockCancellation(),
            onTokensSaved: () => {
              saved = true;
            },
          };
          const failure = () =>
            new Error(
              saved
                ? `Authentication saved, but sign-in cleanup did not finish. Close this dialog and check the ${settingsOwner} before trying again.`
                : settingsOwner === "MCP server"
                  ? "Sign-in did not finish. Check the MCP server settings and try again."
                  : "Sign-in did not finish. Check the plugin settings, then select Connect to try again.",
            );
          try {
            try {
              const result = await browser.authorizePrepared<"authorized">({
                timeoutMs: 10 * 60_000,
                prepare: async (redirectUrl) => {
                  const started = await startMcpOAuthAuthorization(identity, config, {
                    redirectUrl,
                    login,
                  });
                  return started.status === "authorized" ? { result: "authorized" } : started;
                },
              });
              if (
                result !== "authorized" &&
                (await completeOAuthCallback(identity, config, result, login)) !== "authorized"
              ) {
                throw new ProviderAuthFailure("timed_out");
              }
            } finally {
              browser.close();
              if (attemptState) {
                await cancelMcpOAuthAuthorization(identity, attemptState);
              }
            }
          } catch (error) {
            if (saved) {
              throw failure();
            }
            const providerFailure = readProviderAuthFailure(error);
            if (providerFailure) {
              context.logGateway.warn(
                `MCP sign-in failed for server "${params.serverName}": ${providerFailure.reason}`,
              );
              throw providerFailure;
            }
            const {
              AuthorizationServerMismatchError,
              IssuerMismatchError,
              OAuthError,
              RegistrationRejectedError,
            } = await import("@modelcontextprotocol/client");
            let reason = "unexpected";
            let message: string | undefined;
            // Provider errors can contain callback codes, tokens, and untrusted text.
            // Select fixed copy instead of exposing their messages or response bodies.
            if (
              error instanceof IssuerMismatchError ||
              error instanceof AuthorizationServerMismatchError
            ) {
              reason = "provider-mismatch";
              message =
                "OpenClaw could not verify the sign-in provider. Close this dialog, review the connection settings, and try again.";
            } else if (error instanceof McpOAuthCredentialsRetainedError) {
              reason = "credentials-retained";
              message =
                "The sign-in service rejected this attempt. Existing credentials were not changed. Close this dialog, review the connection settings, and try again.";
            } else if (error instanceof RegistrationRejectedError) {
              reason = "registration-rejected";
              message =
                "The sign-in service rejected this connection's settings. Close this dialog and review the connection settings before trying again.";
            } else if (error instanceof OAuthError) {
              reason = "provider-rejected";
              message =
                "The sign-in service rejected this attempt. Close this dialog and try again.";
            } else if (isTransientNetworkError(error)) {
              reason = "network";
              message =
                "OpenClaw could not reach the sign-in service. Check this Gateway's network connection, then close this dialog and try again.";
            }
            context.logGateway.warn(
              `MCP sign-in failed for server "${params.serverName}": ${reason}`,
            );
            throw message ? new Error(message) : failure();
          }
        }),
    });
  },
};
