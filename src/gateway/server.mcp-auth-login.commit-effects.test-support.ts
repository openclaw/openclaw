import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import type { WizardNextResult } from "../../packages/gateway-protocol/src/index.js";
import type { McpOAuthIdentity } from "../agents/mcp-oauth-identity.js";
import type { McpOAuthLoginLifecycle } from "../agents/mcp-oauth-provider.js";
import * as oauthStore from "../agents/mcp-oauth-store.js";
import * as oauthCoordinator from "../agents/mcp-oauth.js";

type McpAuthCommitEffectFixture = {
  identity: () => McpOAuthIdentity;
  resourceUrl: () => string;
  seed: () => Promise<void>;
  stored: () => Promise<oauthStore.McpOAuthStore>;
  begin: () => Promise<{ sessionId: string; state: string }>;
  callback: (state: string) => Promise<Response>;
  start: () => Promise<string>;
  finishError: (sessionId: string) => Promise<WizardNextResult>;
  revoke: () => void;
  observeLogin: (observe: (login: McpOAuthLoginLifecycle) => void) => void;
  registerRestore: (restore: () => void) => void;
};

export function registerMcpAuthCommitEffects(fixture: McpAuthCommitEffectFixture) {
  const {
    identity,
    resourceUrl,
    seed,
    stored,
    begin,
    callback,
    start,
    finishError,
    revoke,
    observeLogin,
    registerRestore,
  } = fixture;
  const revokeAfterMutation = (kind: "tokens" | "authorizationRedirect") => {
    const mutate = oauthStore.mutateMcpOAuthStore;
    const spy = vi.spyOn(oauthStore, "mutateMcpOAuthStore").mockImplementation(async (...args) => {
      const result = await mutate(...args);
      if (args[1].kind === kind) {
        revoke();
      }
      return result;
    });
    registerRestore(() => spy.mockRestore());
  };
  it("rolls back the token write when authority is withdrawn at its commit hook", async () => {
    await seed();
    const before = await stored();
    expect(
      await oauthCoordinator.recordMcpOAuthAuthorizationRequired({
        identity: identity(),
        rejectedAccessToken: "fixture-access",
        scope: "expanded",
      }),
    ).toBe(true);
    const started = await begin();
    let commitHooks = 0;
    let acknowledgments = 0;
    observeLogin((login) => {
      const beforeTokensSaved = login.beforeTokensSaved;
      vi.spyOn(login, "beforeTokensSaved").mockImplementation(() => {
        commitHooks++;
        beforeTokensSaved();
        revoke();
      });
      const onTokensSaved = login.onTokensSaved;
      vi.spyOn(login, "onTokensSaved").mockImplementation(() => {
        acknowledgments++;
        onTokensSaved();
      });
    });

    expect((await callback(started.state)).status).toBe(200);
    const result = await finishError(started.sessionId);
    expect(result.error).toContain("Sign-in did not finish");
    expect(result.error).not.toContain("Authentication saved");
    expect(commitHooks).toBe(1);
    expect(acknowledgments).toBe(0);
    const after = await stored();
    expect(after.tokens).toEqual(before.tokens);
    expect(after.tokenExpiresAt).toBe(before.tokenExpiresAt);
    expect(after.tokensAuthorizationServerUrl).toBe(before.tokensAuthorizationServerUrl);
    expect(after.clientInformation).toEqual(before.clientInformation);
    expect(after.pendingAuthorizationChallenge).toMatchObject({ requiresAuthorization: true });
    expect(after.codeVerifier).toBeUndefined();
    expect(after.lastAuthorizationUrl).toBeUndefined();
    expect(await oauthStore.readMcpOAuthPendingAuthorization(started.state)).toBeUndefined();
  });

  it("reports saved authentication when authority ends before provider bookkeeping", async () => {
    const started = await begin();
    revokeAfterMutation("tokens");
    let acknowledgments = 0;
    observeLogin((login) => {
      const onTokensSaved = login.onTokensSaved;
      vi.spyOn(login, "onTokensSaved").mockImplementation(() => {
        acknowledgments++;
        onTokensSaved();
      });
    });

    expect((await callback(started.state)).status).toBe(200);
    const result = await finishError(started.sessionId);
    expect(result.error).toContain("Authentication saved, but sign-in cleanup did not finish");
    expect(acknowledgments).toBe(1);
    const after = await stored();
    expect(after.tokens?.access_token).toBe("fixture-access");
    expect(after.tokensAuthorizationServerUrl).toBe(new URL(resourceUrl()).origin);
    expect(after.codeVerifier).toBeUndefined();
    expect(after.lastAuthorizationUrl).toBeUndefined();
    expect(await oauthStore.readMcpOAuthPendingAuthorization(started.state)).toBeUndefined();
    expect((await callback(started.state)).status).toBe(410);
  });

  it("cleans up a durable redirect when authority ends before provider bookkeeping", async () => {
    revokeAfterMutation("authorizationRedirect");
    const published: string[] = [];
    observeLogin((login) => {
      const onAuthorizationPublished = login.onAuthorizationPublished;
      vi.spyOn(login, "onAuthorizationPublished").mockImplementation((state) => {
        published.push(state);
        onAuthorizationPublished(state);
      });
    });

    const result = await finishError(await start());
    expect(result.error).toContain("Sign-in did not finish");
    expect(published).toHaveLength(1);
    const state = expectDefined(published[0], "acknowledged authorization state");
    const after = await stored();
    expect(after.tokens).toBeUndefined();
    expect(after.codeVerifier).toBeUndefined();
    expect(after.lastAuthorizationUrl).toBeUndefined();
    expect(after.redirectUrl).toBeUndefined();
    expect(await oauthStore.readMcpOAuthPendingAuthorization(state)).toBeUndefined();
    expect((await callback(state)).status).toBe(410);
  });
}
