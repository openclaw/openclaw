import { describe, expect, it, vi } from "vitest";
import { CHUTES_TOKEN_ENDPOINT, CHUTES_USERINFO_ENDPOINT } from "../agents/chutes-oauth.js";
import { loginChutes } from "./chutes-oauth.js";

const urlToString = (url: Request | URL | string): string => {
  if (typeof url === "string") {
    return url;
  }
  return "url" in url ? url.url : String(url);
};

describe("loginChutes", () => {
  it("captures local redirect and exchanges code for tokens", async () => {
    // Use port 0 so the OS assigns a free port — avoids TOCTOU race from
    // finding-then-releasing a port before the callback server can bind it.
    const redirectUri = "http://127.0.0.1:0/oauth-callback";
    let boundPort = 0;

    const fetchFn: typeof fetch = async (input, init) => {
      const url = urlToString(input);
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
        // Use the actual bound port (reported via onListening) instead of
        // the placeholder port 0 from the redirect URI.
        await fetch(`http://127.0.0.1:${boundPort}/oauth-callback?code=code_local&state=${state}`);
      },
      onPrompt,
      fetchFn,
      onListening: (address) => {
        boundPort = address.port;
      },
    });

    expect(onPrompt).not.toHaveBeenCalled();
    expect(creds.access).toBe("at_local");
    expect(creds.refresh).toBe("rt_local");
    expect(creds.email).toBe("local-user");
  });

  it("supports manual flow with pasted code", async () => {
    const fetchFn: typeof fetch = async (input) => {
      const url = urlToString(input);
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
      const url = urlToString(input);
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
