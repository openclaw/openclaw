import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { CHUTES_TOKEN_ENDPOINT, CHUTES_USERINFO_ENDPOINT } from "../agents/chutes-oauth.js";
import { loginChutes } from "./chutes-oauth.js";

/**
 * Get a free port and hold it until release() is called.
 * This prevents port race conditions when running tests in parallel.
 */
async function getFreePort(): Promise<{ port: number; release: () => Promise<void> }> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("No TCP address")));
        return;
      }
      const port = address.port;
      // Keep server open - return a release function for cleanup
      resolve({
        port,
        release: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

// Use describe.sequential for port-dependent tests to avoid race conditions
// when other parallel tests might grab the same port after release
describe.sequential("loginChutes", () => {
  it("captures local redirect and exchanges code for tokens", async () => {
    const { port, release } = await getFreePort();
    const redirectUri = `http://127.0.0.1:${port}/oauth-callback`;
    // Release port reservation just before loginChutes needs it
    // Sequential execution ensures no other test grabs this port
    await release();

    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === CHUTES_TOKEN_ENDPOINT) {
        return new Response(
          JSON.stringify({
            access_token: "at_local",
            refresh_token: "rt_local",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === CHUTES_USERINFO_ENDPOINT) {
        return new Response(JSON.stringify({ username: "local-user" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return fetch(input, init);
    };

    const onPrompt = vi.fn(async () => {
      throw new Error("onPrompt should not be called for local callback");
    });

    const creds = await loginChutes({
      app: { clientId: "cid_test", redirectUri, scopes: ["openid"] },
      onAuth: async ({ url }) => {
        const state = new URL(url).searchParams.get("state");
        expect(state).toBeTruthy();
        await fetch(`${redirectUri}?code=code_local&state=${state}`);
      },
      onPrompt,
      fetchFn,
    });

    expect(onPrompt).not.toHaveBeenCalled();
    expect(creds.access).toBe("at_local");
    expect(creds.refresh).toBe("rt_local");
    expect(creds.email).toBe("local-user");
  });

  it("supports manual flow with pasted code", async () => {
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url === CHUTES_TOKEN_ENDPOINT) {
        return new Response(
          JSON.stringify({
            access_token: "at_manual",
            refresh_token: "rt_manual",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === CHUTES_USERINFO_ENDPOINT) {
        return new Response(JSON.stringify({ username: "manual-user" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const creds = await loginChutes({
      app: {
        clientId: "cid_test",
        redirectUri: "http://127.0.0.1:1456/oauth-callback",
        scopes: ["openid"],
      },
      manual: true,
      onAuth: async () => {},
      onPrompt: async () => "code_manual",
      fetchFn,
    });

    expect(creds.access).toBe("at_manual");
    expect(creds.refresh).toBe("rt_manual");
    expect(creds.email).toBe("manual-user");
  });

  it("does not reuse code_verifier as state", async () => {
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url === CHUTES_TOKEN_ENDPOINT) {
        return new Response(
          JSON.stringify({
            access_token: "at_manual",
            refresh_token: "rt_manual",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === CHUTES_USERINFO_ENDPOINT) {
        return new Response(JSON.stringify({ username: "manual-user" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const createPkce = () => ({
      verifier: "verifier_123",
      challenge: "chal_123",
    });
    const createState = () => "state_456";

    const creds = await loginChutes({
      app: {
        clientId: "cid_test",
        redirectUri: "http://127.0.0.1:1456/oauth-callback",
        scopes: ["openid"],
      },
      manual: true,
      createPkce,
      createState,
      onAuth: async ({ url }) => {
        const parsed = new URL(url);
        expect(parsed.searchParams.get("state")).toBe("state_456");
        expect(parsed.searchParams.get("state")).not.toBe("verifier_123");
      },
      onPrompt: async () => "code_manual",
      fetchFn,
    });

    expect(creds.access).toBe("at_manual");
  });

  it("rejects pasted redirect URLs missing state", async () => {
    const fetchFn: typeof fetch = async () => new Response("not found", { status: 404 });

    await expect(
      loginChutes({
        app: {
          clientId: "cid_test",
          redirectUri: "http://127.0.0.1:1456/oauth-callback",
          scopes: ["openid"],
        },
        manual: true,
        createPkce: () => ({ verifier: "verifier_123", challenge: "chal_123" }),
        createState: () => "state_456",
        onAuth: async () => {},
        onPrompt: async () => "http://127.0.0.1:1456/oauth-callback?code=code_only",
        fetchFn,
      }),
    ).rejects.toThrow("Missing 'state' parameter");
  });
});
