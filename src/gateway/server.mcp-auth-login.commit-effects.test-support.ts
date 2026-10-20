import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import type { WizardNextResult } from "../../packages/gateway-protocol/src/index.js";
import type { McpOAuthIdentity } from "../agents/mcp-oauth-identity.js";
import type { McpOAuthLoginLifecycle } from "../agents/mcp-oauth-provider.js";
import * as oauthStore from "../agents/mcp-oauth-store.js";
import * as oauthCoordinator from "../agents/mcp-oauth.js";

export function registerMcpAuthCommitEffects(f: {
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
}) {
  const expectPendingCleared = async (state: string) => {
    const after = await f.stored();
    expect(after.codeVerifier).toBeUndefined();
    expect(after.lastAuthorizationUrl).toBeUndefined();
    expect(await oauthStore.readMcpOAuthPendingAuthorization(state)).toBeUndefined();
    return after;
  };
  const revokeAfterMutation = (kind: "tokens" | "authorizationRedirect") => {
    const mutate = oauthStore.mutateMcpOAuthStore;
    const spy = vi.spyOn(oauthStore, "mutateMcpOAuthStore").mockImplementation(async (...args) => {
      const result = await mutate(...args);
      if (args[1].kind === kind) {
        f.revoke();
      }
      return result;
    });
    f.registerRestore(() => spy.mockRestore());
  };
  it("rolls back the token write when authority is withdrawn at its commit hook", async () => {
    await f.seed();
    const before = await f.stored();
    const required = await oauthCoordinator.recordMcpOAuthAuthorizationRequired({
      identity: f.identity(),
      rejectedAccessToken: "fixture-access",
      scope: "expanded",
    });
    expect(required).toBe(true);
    const started = await f.begin();
    let observed: McpOAuthLoginLifecycle | undefined;
    f.observeLogin((login) => {
      observed = login;
      const beforeTokensSaved = login.beforeTokensSaved;
      vi.spyOn(login, "beforeTokensSaved").mockImplementation(() => {
        beforeTokensSaved();
        f.revoke();
      });
      vi.spyOn(login, "onTokensSaved");
    });

    expect((await f.callback(started.state)).status).toBe(200);
    const result = await f.finishError(started.sessionId);
    expect(result.error).toContain("Sign-in did not finish");
    expect(result.error).not.toContain("Authentication saved");
    expect(observed?.beforeTokensSaved).toHaveBeenCalledTimes(1);
    expect(observed?.onTokensSaved).toHaveBeenCalledTimes(0);
    const after = await expectPendingCleared(started.state);
    expect(after.tokens).toEqual(before.tokens);
    expect(after.tokenExpiresAt).toBe(before.tokenExpiresAt);
    expect(after.tokensAuthorizationServerUrl).toBe(before.tokensAuthorizationServerUrl);
    expect(after.clientInformation).toEqual(before.clientInformation);
    expect(after.pendingAuthorizationChallenge).toMatchObject({ requiresAuthorization: true });
  });

  it("reports saved authentication when authority ends before provider bookkeeping", async () => {
    const started = await f.begin();
    revokeAfterMutation("tokens");
    let observed: McpOAuthLoginLifecycle | undefined;
    f.observeLogin((login) => {
      observed = login;
      vi.spyOn(login, "onTokensSaved");
    });

    expect((await f.callback(started.state)).status).toBe(200);
    const result = await f.finishError(started.sessionId);
    expect(result.error).toContain("Authentication saved, but sign-in cleanup did not finish");
    expect(observed?.onTokensSaved).toHaveBeenCalledTimes(1);
    const after = await expectPendingCleared(started.state);
    expect(after.tokens?.access_token).toBe("fixture-access");
    expect(after.tokensAuthorizationServerUrl).toBe(new URL(f.resourceUrl()).origin);
    expect((await f.callback(started.state)).status).toBe(410);
  });

  it("cleans up a durable redirect when authority ends before provider bookkeeping", async () => {
    revokeAfterMutation("authorizationRedirect");
    let published: McpOAuthLoginLifecycle["onAuthorizationPublished"] | undefined;
    f.observeLogin((login) => {
      published = vi.spyOn(login, "onAuthorizationPublished");
    });

    const result = await f.finishError(await f.start());
    expect(result.error).toContain("Sign-in did not finish");
    const publication = vi.mocked(expectDefined(published, "authorization publication hook"));
    expect(publication).toHaveBeenCalledTimes(1);
    const state = expectDefined(publication.mock.calls[0]?.[0], "acknowledged authorization state");
    const after = await expectPendingCleared(state);
    expect(after.tokens).toBeUndefined();
    expect(after.redirectUrl).toBeUndefined();
    expect((await f.callback(state)).status).toBe(410);
  });
}
