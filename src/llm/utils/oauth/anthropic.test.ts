import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type * as Loopback from "../../../infra/oauth-loopback-callback.js";

const startOAuthLoopbackCallbackServer = vi.hoisted(() =>
  vi.fn<typeof Loopback.startOAuthLoopbackCallbackServer>(),
);

vi.mock("../../../infra/oauth-loopback-callback.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../infra/oauth-loopback-callback.js")>();
  startOAuthLoopbackCallbackServer.mockImplementation(actual.startOAuthLoopbackCallbackServer);
  return { ...actual, startOAuthLoopbackCallbackServer };
});

import { anthropicOAuthProvider } from "./anthropic.js";
import type { OAuthLoginCallbacks } from "./types.js";

const ANTHROPIC_REDIRECT_URI = "http://localhost:53692/callback";
const login = (options: Partial<OAuthLoginCallbacks> = {}) =>
  anthropicOAuthProvider.login({
    onAuth: vi.fn(),
    onPrompt: async () => {
      throw new Error("callback server did not settle the login");
    },
    ...options,
  });
const callbackServer = (
  waitForCallback: Loopback.OAuthLoopbackCallbackServer["waitForCallback"] = vi.fn(),
) => ({
  waitForCallback,
  complete: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
});
function stubResponse(body: BodyInit) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
}
const refresh = () =>
  anthropicOAuthProvider.refreshToken({
    access: "expired",
    refresh: "old",
    expires: 0,
  });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Anthropic OAuth", () => {
  it.each([
    "manual",
    "timeout",
    "empty",
    "wrong state",
    "empty state",
    "rejection",
    "no manual",
  ] as const)("settles %s input through one prompt and closes the callback", async (entry) => {
    const manual = createDeferred<string>();
    const ready = createDeferred();
    const callback =
      createDeferred<
        Awaited<ReturnType<Loopback.OAuthLoopbackCallbackServer["waitForCallback"]>>
      >();
    const close = vi.fn(async () => callback.reject(new Error("OAuth callback cancelled")));
    startOAuthLoopbackCallbackServer.mockResolvedValueOnce({
      ...callbackServer(() => callback.promise),
      close,
    });
    const tokenExchange = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
    );
    vi.stubGlobal("fetch", tokenExchange);
    const onPrompt = vi.fn(async () => "fallback-code");
    let expectedState: string | null = null;
    const pending = login({
      onAuth: ({ url }) => {
        expectedState = new URL(url).searchParams.get("state");
        ready.resolve();
      },
      onPrompt,
      ...(entry === "no manual" ? {} : { onManualCodeInput: () => manual.promise }),
    });
    const outcome = pending.catch((error: unknown) => error);
    await ready.promise;
    if (entry === "timeout" || entry === "no manual") {
      callback.reject(new Error("OAuth callback timeout"));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      if (entry === "timeout") {
        expect(onPrompt).not.toHaveBeenCalled();
      }
    }
    if (entry === "rejection") {
      manual.reject("manual entry failed");
    } else {
      manual.resolve(
        entry === "empty"
          ? ""
          : entry === "wrong state"
            ? "manual-code#wrong"
            : entry === "empty state"
              ? "manual-code#"
              : "manual-code",
      );
    }
    const result = await outcome;
    expect(close).toHaveBeenCalled();
    if (entry === "wrong state" || entry === "empty state" || entry === "rejection") {
      expect(result).toMatchObject({
        message:
          entry === "wrong state"
            ? "OAuth state mismatch"
            : entry === "empty state"
              ? "Missing OAuth state"
              : "manual entry failed",
      });
      expect(tokenExchange).not.toHaveBeenCalled();
      expect(onPrompt).not.toHaveBeenCalled();
    } else {
      expect(result).toMatchObject({ access: "access", refresh: "refresh" });
      const fallback = entry === "empty" || entry === "no manual";
      expect(onPrompt).toHaveBeenCalledTimes(fallback ? 1 : 0);
      expect(tokenExchange).toHaveBeenCalledOnce();
      const body = tokenExchange.mock.calls[0]?.[1]?.body;
      if (typeof body !== "string") {
        throw new Error("token exchange did not send a JSON string body");
      }
      expect(JSON.parse(body)).toMatchObject({
        code: fallback ? "fallback-code" : "manual-code",
        state: expectedState,
        redirect_uri: ANTHROPIC_REDIRECT_URI,
      });
    }
  });

  it("cancels provider login before opening the OAuth flow", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(login({ signal: controller.signal })).rejects.toThrow("Login cancelled");
  });

  it("does not open the OAuth flow after cancellation during setup", async () => {
    const controller = new AbortController();
    const onAuth = vi.fn();
    const server = callbackServer();
    startOAuthLoopbackCallbackServer.mockResolvedValueOnce(server);
    const loginPromise = login({ onAuth, signal: controller.signal });
    controller.abort();
    await expect(loginPromise).rejects.toThrow("Login cancelled");
    expect(onAuth).not.toHaveBeenCalled();
    expect(server.close).toHaveBeenCalledOnce();
  });

  it("does not echo token payload values when refresh JSON parsing fails", async () => {
    stubResponse('{"access_token":"secret-access-token","refresh_token":"secret-refresh"');
    try {
      await refresh();
      throw new Error("Expected refresh to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("Anthropic token refresh returned invalid JSON.");
      expect(message).not.toMatch(/secret-access-token|secret-refresh|access_token|refresh_token/);
      expect(message).toContain("bodyBytes=");
    }
  });
  it("rejects unsafe token lifetimes from refresh responses", async () => {
    stubResponse(
      '{"access_token":"new-access-token","refresh_token":"new-refresh-token","expires_in":1e309}',
    );
    await expect(refresh()).rejects.toThrow(
      "Anthropic token refresh returned invalid token fields.",
    );
  });

  it("rejects an oversized Anthropic token refresh response", async () => {
    let pullCount = 0;
    const cancel = vi.fn(async () => undefined);
    const oversizedStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        controller.enqueue(new Uint8Array(pullCount === 1 ? 16 * 1024 * 1024 + 1 : 1));
      },
      cancel,
    });
    stubResponse(oversizedStream);
    await expect(refresh()).rejects.toThrow("too large");
    expect(pullCount).toBeLessThanOrEqual(2);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects non-loopback callback bind hosts", async () => {
    vi.stubEnv("OPENCLAW_OAUTH_CALLBACK_HOST", "0.0.0.0");
    await expect(login()).rejects.toThrow(
      "Anthropic OAuth callback host must be localhost, 127.0.0.1, or ::1",
    );
  });

  it("binds IPv4 loopback while keeping Anthropic's registered localhost redirect", async () => {
    vi.stubEnv("OPENCLAW_OAUTH_CALLBACK_HOST", "127.0.0.1");
    startOAuthLoopbackCallbackServer.mockImplementationOnce(async (params) =>
      callbackServer(async () => ({
        type: "authorization_code" as const,
        code: "authorization-code",
        state: params.expectedState,
        parameters: new URLSearchParams({
          code: "authorization-code",
          state: params.expectedState,
        }),
      })),
    );
    const tokenExchange = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string") {
        throw new Error("token exchange did not send a JSON string body");
      }
      const body = JSON.parse(init.body) as { redirect_uri?: string };
      expect(body.redirect_uri).toBe(ANTHROPIC_REDIRECT_URI);
      return Response.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
      });
    });
    vi.stubGlobal("fetch", tokenExchange);
    const credentials = await login({
      onAuth: ({ url }) => {
        const authorizationUrl = new URL(url);
        expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(ANTHROPIC_REDIRECT_URI);
        expect(authorizationUrl.searchParams.get("state")).toBeTruthy();
      },
    });
    expect(startOAuthLoopbackCallbackServer).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUrl: ANTHROPIC_REDIRECT_URI, bindHostname: "127.0.0.1" }),
    );
    expect(credentials).toMatchObject({ access: "access-token", refresh: "refresh-token" });
    expect(tokenExchange).toHaveBeenCalledOnce();
  });

  it("settles an OAuth error callback immediately", async () => {
    vi.stubEnv("OPENCLAW_OAUTH_CALLBACK_HOST", "127.0.0.1");
    startOAuthLoopbackCallbackServer.mockResolvedValueOnce(
      callbackServer(async () => ({ type: "oauth_error", error: "access_denied" })),
    );
    const loginPromise = login({
      onAuth: ({ url }) => {
        expect(new URL(url).searchParams.get("state")).toBeTruthy();
      },
    });
    await expect(loginPromise).rejects.toThrow("Anthropic OAuth error: access_denied");
  });
});
