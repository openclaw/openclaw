// Failure matrix: every provider sign-in kind and a later-turn failure, rendered on each surface.
// Failures are built by shape (an Error named ProviderAuthFailure with a reason), the contract
// plugins on older SDKs use, so this suite runs unchanged against hosts without the class.
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderAuthError } from "../agents/model-auth-runtime-shared.js";
import { formatProviderLoginFailure } from "../auto-reply/provider-login-recovery.js";
import { buildExternalRunFailureReply } from "../auto-reply/reply/agent-runner-failure-reply.js";
import {
  createProviderBrowserAuthSession,
  handleProviderOAuthCallback,
  PROVIDER_OAUTH_CALLBACK_PATH,
} from "../gateway/provider-browser-auth.js";
import { createRequest, createResponse } from "../gateway/server-http.test-harness.js";
import { prepareTailscalePublishedOrigin } from "../gateway/tailscale-published-origin.js";
import { waitForLocalOAuthCallback } from "../plugin-sdk/provider-auth-runtime.js";
import { WizardSession } from "../wizard/session.js";
import type { ProviderChannelLoginChoice } from "./provider-login-options.js";

const failure = (reason: string, message = `${reason} sentence.`) =>
  Object.assign(new Error(message), { name: "ProviderAuthFailure", reason });
const choice: ProviderChannelLoginChoice = {
  choiceId: "acme",
  pluginId: "acme",
  providerId: "acme",
  methodId: "oauth",
  label: "Acme login",
  providerLabel: "Acme",
  command: "acme",
  mode: "chat",
};
const CLI_COMMAND = /openclaw (models auth login|configure)/;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

async function sessionResult(error: Error) {
  const session = new WizardSession(async () => {
    throw error;
  });
  await session.whenSettled();
  return await session.next();
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => {
    server.close(resolve);
  });
  return port;
}

function get(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    request(url, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    })
      .on("error", reject)
      .end();
  });
}

describe("browser redirect", () => {
  it("keeps the loopback listening after a refusal so the user can go back and allow", async () => {
    const port = await freePort();
    const progress: string[] = [];
    const callback = waitForLocalOAuthCallback({
      expectedState: "s1",
      timeoutMs: 10_000,
      port,
      callbackPath: "/cb",
      redirectUri: `http://127.0.0.1:${port}/cb`,
      successTitle: "Done",
      onProgress: (message) => progress.push(message),
    });
    void callback.catch(() => {});
    await expect.poll(() => progress.length).toBe(1);
    expect(await get(`http://127.0.0.1:${port}/cb?state=s1&error=access_denied`)).toBe(400);
    await expect.poll(() => progress.at(-1)).toMatch(/allow access/);
    expect(await get(`http://127.0.0.1:${port}/cb?state=s1&code=allowed`)).toBe(200);
    await expect(callback).resolves.toMatchObject({ code: "allowed" });
  });

  it("keeps a Gateway-origin sign-in open after a refusal, then accepts the allowed code", async () => {
    cleanups.push(prepareTailscalePublishedOrigin({ origin: "https://gw.example", mode: "serve" }));
    const session = createProviderBrowserAuthSession({ openUrl: async () => {} });
    cleanups.push(session.close);
    const result = session.authorize({
      state: "s1",
      timeoutMs: 60_000,
      buildAuthorizationUrl: (redirect) => `https://provider.example/auth?r=${redirect}`,
    });
    const callback = (query: string) => {
      const response = createResponse();
      handleProviderOAuthCallback(
        createRequest({ path: `${PROVIDER_OAUTH_CALLBACK_PATH}?${query}` }),
        response.res,
      );
      return response;
    };
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(callback("state=s1&error=access_denied").getBody()).toMatch(/allow access/);
    expect(callback("state=s1&code=c1").res.statusCode).toBe(200);
    await expect(result).resolves.toMatchObject({ code: "c1" });
  });

  it("ends an expired Gateway-origin sign-in without chat or CLI syntax", async () => {
    cleanups.push(prepareTailscalePublishedOrigin({ origin: "https://gw.example", mode: "serve" }));
    const session = createProviderBrowserAuthSession({ openUrl: async () => {} });
    cleanups.push(session.close);
    const result = session.authorize({
      state: "s2",
      timeoutMs: 1,
      buildAuthorizationUrl: (redirect) => `https://provider.example/auth?r=${redirect}`,
    });
    const error: unknown = await result.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: "timed_out" });
    expect(String(error)).not.toMatch(/\/login|CLI/);
  });
});

describe("every failure on every surface", () => {
  // kind, reason, chat next step
  const rows = [
    ["device code", "device_code_expired", "/login acme"],
    ["device code", "device_code_denied", "/login acme"],
    ["browser redirect", "callback_port_busy", "Open Models in the OpenClaw app"],
    ["browser redirect", "grant_rejected", "/login acme"],
    ["exchange", "network", "/login acme"],
    ["node relay", "relay_denied", "Open Models in the OpenClaw app"],
    ["exchange", "rate_limited", "Wait a few minutes"],
    ["admin", "admin_blocked", "Ask your administrator"],
  ] as const;

  it.each(rows)("%s %s: the Gateway result carries the reason", async (_kind, reason) => {
    await expect(sessionResult(failure(reason))).resolves.toMatchObject({
      done: true,
      status: "error",
      error: `${reason} sentence.`,
      reason,
    });
  });

  it.each(rows)("%s %s: chat shows the reason and the chat next step", (_kind, reason, next) => {
    const text = formatProviderLoginFailure(choice, failure(reason));
    expect(text).toContain(`${reason} sentence.`);
    expect(text).toContain(next);
    expect(text).not.toMatch(CLI_COMMAND);
  });

  it.each(rows)("%s %s: only the CLI prints the terminal command", async (_kind, reason) => {
    const { formatProviderAuthFailureForCli } =
      await import("../commands/models/auth-login-gateway.js");
    const text = formatProviderAuthFailureForCli(reason, `${reason} sentence.`, "acme");
    expect(text).toContain(`${reason} sentence.`);
    if (reason !== "admin_blocked") {
      expect(text).toContain("openclaw models auth login --provider acme");
    }
  });
});

describe("later turns", () => {
  it("renders an ended sign-in as /login with a Sign in button, never a CLI command", () => {
    const fence = new ProviderAuthError(
      "missing-provider-auth",
      "acme",
      'The acme sign-in "acme:a" has ended or was rejected.',
      { providerGuidance: true },
    );
    Object.defineProperty(fence, "cause", {
      value: failure("refresh_rejected", "This sign-in has ended or was rejected."),
    });
    const reply = buildExternalRunFailureReply({ message: fence.message, error: fence });
    expect(reply.text).toContain("/login acme");
    expect(reply.text).not.toMatch(CLI_COMMAND);
    expect(reply.text).not.toContain("isn't set up yet");
    expect(JSON.stringify(reply.presentation)).toContain("Sign in");
  });
});
