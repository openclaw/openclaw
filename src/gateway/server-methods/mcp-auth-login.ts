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
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { WizardSession } from "../../wizard/session.js";
import {
  createProviderBrowserAuthSession,
  ProviderBrowserSignInError,
  ProviderBrowserSignInUnavailableError,
} from "../provider-browser-auth.js";
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
        "This MCP server cannot use operator browser sign-in. Check its existing account settings.",
      );
      return;
    }
    const { config } = connection;
    const identity = operatorMcpOAuthIdentity(
      params.serverName,
      config.url,
      context.getRuntimeConfig(),
    );
    // Plugin-declared servers have no CLI sign-in path, so recovery points at the plugin.
    const terminalLogin = mcpOAuthCliLoginSteps(identity);
    const settingsOwner = terminalLogin ? "MCP server" : "plugin";
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
      if (client.invalidated || !client.connect.scopes?.includes("operator.admin")) {
        throw new Error("Sign-in authority is no longer active.");
      }
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
                : terminalLogin
                  ? `Sign-in did not finish. Check the MCP server settings and try again, or sign in from this Gateway's terminal: ${terminalLogin}.`
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
                throw new ProviderBrowserSignInError("expired");
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
            if (error instanceof ProviderBrowserSignInUnavailableError) {
              throw error;
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
            } else if (error instanceof ProviderBrowserSignInError) {
              reason = error.reason;
              message =
                error.reason === "expired"
                  ? "This sign-in attempt expired. Close this dialog and start sign-in again."
                  : "The provider did not approve sign-in. Close this dialog and try again.";
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
