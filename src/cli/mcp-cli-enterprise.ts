import * as oidc from "openid-client";
import type { McpEnterpriseConfig } from "../agents/mcp-enterprise.js";
import { discoverMcpEnterpriseIdp, mcpEnterpriseIdpStoreKey } from "../agents/mcp-enterprise.js";
import { buildMcpOAuthHttpFetch } from "../agents/mcp-http-fetch.js";
import type { McpOAuthLoginLifecycle } from "../agents/mcp-oauth-provider.js";
import { withMcpOAuthLeaseSignal } from "../agents/mcp-oauth-provider.js";
import { mutateMcpOAuthStore } from "../agents/mcp-oauth-store.js";
import { startOAuthLoopbackCallbackServer } from "../infra/oauth-loopback-callback.js";
import { defaultRuntime } from "../runtime.js";
import { withOpenClawStateLeaseAsync } from "../state/openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

/** Sign the operator in once at the IdP for every MCP resource using this client. */
export async function loginMcpEnterprise(params: {
  name: string;
  config: McpEnterpriseConfig;
  owner: Pick<McpOAuthLoginLifecycle, "signal" | "assertCurrent">;
}): Promise<void> {
  const { name, config, owner } = params;
  owner.assertCurrent();
  const oidcFetch = withMcpOAuthLeaseSignal(
    buildMcpOAuthHttpFetch({
      resourceUrl: config.idpIssuer,
      timeoutMs: 30_000,
      beforeRequest: owner.assertCurrent,
    }),
    owner.signal,
    owner.assertCurrent,
  );
  const discovered = await discoverMcpEnterpriseIdp(config, oidcFetch);
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const authorizationUrl = oidc.buildAuthorizationUrl(discovered, {
    redirect_uri: config.redirectUrl,
    scope: "openid email profile offline_access",
    state,
    nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
  });
  const callbackServer = await startOAuthLoopbackCallbackServer({
    redirectUrl: config.redirectUrl,
    expectedState: state,
    timeoutMs: CALLBACK_TIMEOUT_MS,
    signal: owner.signal,
  });
  try {
    defaultRuntime.log(`Open this URL to sign in for MCP server "${name}":`);
    defaultRuntime.log(authorizationUrl.href);
    defaultRuntime.log("Waiting for the enterprise sign-in callback...");
    const callback = await callbackServer.waitForCallback();
    if (callback.type !== "authorization_code") {
      throw new Error("Enterprise sign-in did not complete.");
    }
    owner.assertCurrent();
    const callbackUrl = new URL(config.redirectUrl);
    callbackUrl.search = callback.parameters.toString();
    const tokens = await oidc.authorizationCodeGrant(discovered, callbackUrl, {
      pkceCodeVerifier: verifier,
      expectedState: state,
      expectedNonce: nonce,
    });
    const expiresAt = tokens.claims()?.exp;
    if (!tokens.id_token || !expiresAt || expiresAt * 1000 <= Date.now()) {
      throw new Error("The enterprise IdP did not return a valid ID token.");
    }
    const context = captureOpenClawStateWorkerContext();
    const storeKey = mcpEnterpriseIdpStoreKey(config);
    await withOpenClawStateLeaseAsync(
      {
        scope: "core:mcp-oauth",
        key: storeKey,
        leaseMs: 60_000,
        waitMs: 30_000,
        signal: owner.signal,
      },
      context,
      async (lease) => {
        await mutateMcpOAuthStore(
          { storeKey, lease, context },
          {
            kind: "tokens",
            tokens: {
              access_token: tokens.access_token,
              token_type: tokens.token_type,
              id_token: tokens.id_token,
              ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
            },
            tokenExpiresAt: expiresAt * 1000,
            replaceAuthorization: true,
          },
        );
      },
    );
    defaultRuntime.log(`Enterprise SSO credentials saved for "${name}".`);
  } finally {
    await callbackServer.close();
  }
}
