import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, describe, expect, it } from "vitest";
import type { McpAuthLoginLinkResult } from "../../packages/gateway-protocol/src/index.js";
import { clearMcpOAuthCredentials, readMcpOAuthCredentialsStatus } from "../agents/mcp-oauth.js";
import { installMcpAuthLoginSuite } from "./server.mcp-auth-login.test-support.js";
import { connectOk, rpcReq } from "./test-helpers.server.js";

describe("registered mcp.authLogin shared links", () => {
  const suite = installMcpAuthLoginSuite();
  const { identity, store, begin, callback, terminal } = suite;
  let gateway: typeof suite.gateway;
  let owner: typeof suite.owner;
  let readOnly: typeof suite.readOnly;
  beforeAll(() => {
    ({ gateway, owner, readOnly } = suite);
  });

  it("returns a shared sign-in link without a browser and authorizes through the running Gateway callback", async () => {
    await clearMcpOAuthCredentials(identity());
    const cli = await gateway.openWs();
    try {
      const hello = await connectOk(cli, { scopes: ["operator.admin"] });
      expect(hello).toMatchObject({
        features: { methods: expect.arrayContaining(["mcp.authLogin"]) },
      });
      expect((await rpcReq(readOnly, "mcp.authLogin", { serverName: "docs" })).ok).toBe(false);
      const started = await rpcReq<McpAuthLoginLinkResult>(cli, "mcp.authLogin", {
        serverName: "docs",
      });
      expect(started.ok, JSON.stringify(started.error)).toBe(true);
      const link = expectDefined(started.payload, "sign-in link result");
      if (link.status !== "redirect") {
        throw new Error("Expected a sign-in link");
      }
      expect(link.redirectUrl).toBe(`http://127.0.0.1:${gateway.port}/oauth/mcp/callback`);
      const authorization = new URL(link.authorizationUrl);
      suite.expectedChallenge = expectDefined(
        authorization.searchParams.get("code_challenge"),
        "PKCE challenge",
      );
      const repeated = await rpcReq<McpAuthLoginLinkResult>(cli, "mcp.authLogin", {
        serverName: "docs",
      });
      expect(repeated.payload).toEqual(link);
      const redirect = new URL(link.redirectUrl);
      redirect.searchParams.set(
        "state",
        expectDefined(authorization.searchParams.get("state"), "OAuth state"),
      );
      redirect.searchParams.set("code", "fixture-code");
      const response = await fetch(redirect);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Return to the chat.");
      expect(await readMcpOAuthCredentialsStatus(identity())).toMatchObject({
        state: "authorized",
      });
      expect((await store()).tokens?.access_token).toBe("fixture-access");
      expect((await fetch(redirect)).status).toBe(404);
    } finally {
      cli.close();
    }
  });

  it("completes a shared sign-in from a pasted redirect URL", async () => {
    await clearMcpOAuthCredentials(identity());
    const started = await rpcReq<McpAuthLoginLinkResult>(owner, "mcp.authLogin", {
      serverName: "docs",
    });
    const link = expectDefined(started.payload, "sign-in link result");
    if (link.status !== "redirect") {
      throw new Error("Expected a sign-in link");
    }
    const authorization = new URL(link.authorizationUrl);
    suite.expectedChallenge = expectDefined(
      authorization.searchParams.get("code_challenge"),
      "PKCE challenge",
    );
    const redirect = new URL(link.redirectUrl);
    redirect.searchParams.set(
      "state",
      expectDefined(authorization.searchParams.get("state"), "OAuth state"),
    );
    redirect.searchParams.set("code", "fixture-code");
    const completed = await rpcReq<McpAuthLoginLinkResult>(owner, "mcp.authLogin", {
      serverName: "docs",
      callbackUrl: redirect.href,
    });
    expect(completed).toMatchObject({
      ok: true,
      payload: { status: "authorized", serverName: "docs" },
    });
    expect(await readMcpOAuthCredentialsStatus(identity())).toMatchObject({ state: "authorized" });
  });

  it("rejects a browser-bound Settings state at the shared callback", async () => {
    await clearMcpOAuthCredentials(identity());
    const started = await begin();
    try {
      const response = await fetch(
        `http://127.0.0.1:${gateway.port}/oauth/mcp/callback?state=${encodeURIComponent(started.state)}&code=fixture-code`,
      );
      expect(response.status).toBe(404);
      expect((await store()).tokens).toBeUndefined();
      expect((await callback(started.state)).status).toBe(200);
      expect(await terminal(started.sessionId)).toMatchObject({ status: "done" });
    } finally {
      await rpcReq(owner, "wizard.cancel", { sessionId: started.sessionId });
    }
  });
});
