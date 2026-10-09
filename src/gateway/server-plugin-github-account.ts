import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { gitHubPublicApi, githubApiToken } from "./github-public-api.js";
import { resolveGitHubUserIdentityByLogin } from "./github-user-identity.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { withInProcessGatewayRead } from "./server-plugin-in-process-dispatch.js";
import { canTrustedOfficialPluginRequestScopes } from "./server-plugin-subagent-runtime.js";

type ResolveGitHubAccount = NonNullable<PluginRuntime["gateway"]["resolveGitHubAccount"]>;

export async function resolveTrustedPluginGitHubAccount(
  { login, signal }: Parameters<ResolveGitHubAccount>[0],
  resolveGatewayContext?: GatewayContextResolver,
): ReturnType<ResolveGitHubAccount> {
  const scope = getPluginRuntimeGatewayRequestScope();
  if (!canTrustedOfficialPluginRequestScopes(scope ?? {})) {
    throw new Error(
      "GitHub account lookup is only available to bundled or trusted official plugins",
    );
  }
  return await withInProcessGatewayRead(
    {
      method: "users.list",
      scope,
      resolveGatewayContext,
      callerAuthorityError: "GitHub account lookup caller authority is no longer active",
    },
    async (_resolved, assertCurrent) => {
      const signals = [signal, scope?.signal].filter((value) => value !== undefined);
      const requestSignal = signals.length ? AbortSignal.any(signals) : undefined;
      const assertActive = () => {
        assertCurrent();
        requestSignal?.throwIfAborted();
      };
      assertActive();
      let credentialConfigured = false;
      try {
        credentialConfigured = Boolean(githubApiToken(process.env, undefined, "github.com"));
        const { accountId, login: canonicalLogin } = await resolveGitHubUserIdentityByLogin(login, {
          signal: requestSignal,
          allowAnonymousRetry: false,
        });
        assertActive();
        return { accountId, login: canonicalLogin };
      } catch (error) {
        assertActive();
        if (error instanceof gitHubPublicApi.ControlUiGitHubError) {
          return {
            error: {
              statusCode: error.statusCode,
              message: error.message,
              retryAtMs: error.retryAtMs,
              credentialConfigured,
            },
          };
        }
        return {
          error: {
            statusCode: error instanceof TypeError ? 400 : 502,
            message: error instanceof TypeError ? "invalid GitHub login" : "request failed",
            credentialConfigured,
          },
        };
      }
    },
  );
}
