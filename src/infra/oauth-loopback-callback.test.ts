import { createHash } from "node:crypto";
import type { LookupAddress } from "node:dns";
import * as dnsPromises from "node:dns/promises";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { oauthSuccessHtml } from "../plugin-sdk/provider-oauth-runtime.js";
import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import { hasErrnoCode } from "./errno.js";
import {
  startOAuthLoopbackCallbackServer,
  type OAuthLoopbackCallbackServer,
} from "./oauth-loopback-callback.js";

const lookupMock = vi.hoisted(() =>
  vi.fn<(hostname: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]>>(),
);
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  lookupMock.mockImplementation(actual.lookup);
  return { ...actual, lookup: lookupMock };
});

const openCallbacks: OAuthLoopbackCallbackServer[] = [];
const portClaims: TestPortClaim[] = [];
const state = "state-1234567890";
const validQuery = `?code=code&state=${state}`;

afterEach(async () => {
  await Promise.all(openCallbacks.splice(0).map((callback) => callback.close()));
  await Promise.all(portClaims.splice(0).map((claim) => claim.release()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function callbackUrl(hostname: string, port: number, query = ""): string {
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  return `http://${host}:${port}/oauth/callback${query}`;
}

async function getClaimedPort(): Promise<number> {
  const claim = await acquireTestPortBlock({ offsets: [0] });
  portClaims.push(claim);
  return claim.port;
}

type CallbackOptions = Parameters<typeof startOAuthLoopbackCallbackServer>[0];

async function openCallback(
  options: Omit<CallbackOptions, "expectedState"> & { expectedState?: string },
) {
  const callback = await startOAuthLoopbackCallbackServer({
    expectedState: state,
    timeoutMs: 5_000,
    ...options,
  });
  openCallbacks.push(callback);
  return callback;
}

async function start(hostname = "127.0.0.1", options: Partial<CallbackOptions> = {}) {
  const port = await getClaimedPort();
  const callback = await openCallback({
    redirectUrl: callbackUrl(hostname, port),
    ...options,
  });
  return {
    callback,
    port,
    request: (query = "", init?: RequestInit) => fetch(callbackUrl(hostname, port, query), init),
  };
}

async function expectResponse(pending: Promise<Response>, status: number, body?: string) {
  const response = await pending;
  expect(response.status).toBe(status);
  const text = await response.text();
  if (body !== undefined) {
    expect(text).toBe(body);
  }
  return { response, body: text };
}

async function expectClosed(request: () => Promise<Response>) {
  await vi.waitFor(async () => {
    await expect(request()).rejects.toThrow();
  });
}

describe("OAuth loopback callback server", () => {
  it.each(["default", "provider", "ipv6"] as const)(
    "serves CSP-safe %s HTML before closing",
    async (renderer) => {
      const hostname = renderer === "ipv6" ? "::1" : "127.0.0.1";
      const code = renderer === "ipv6" ? "ipv6" : "authorization-code";
      const query = `code=${code}&state=${state}`;
      let started: Awaited<ReturnType<typeof start>>;
      try {
        started = await start(hostname, {
          renderSuccess:
            renderer === "provider"
              ? () => ({
                  body: oauthSuccessHtml("Authorization received"),
                  contentType: "text/html; charset=utf-8",
                })
              : undefined,
        });
      } catch (error) {
        if (
          renderer === "ipv6" &&
          (hasErrnoCode(error, "EADDRNOTAVAIL") || hasErrnoCode(error, "EAFNOSUPPORT"))
        ) {
          return;
        }
        throw error;
      }
      const responsePromise = started.request(`?${query}`);

      await expect(started.callback.waitForCallback()).resolves.toEqual({
        type: "authorization_code",
        code,
        state,
        parameters: new URLSearchParams(query),
      });
      const { response, body } = await expectResponse(responsePromise, 200);
      expect(body).toContain("Authorization received");
      expect(Object.fromEntries(response.headers)).toMatchObject({
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-type": "text/html; charset=utf-8",
      });
      const stylesheet = /<style>([\s\S]*?)<\/style>/.exec(body)?.[1];
      expect(stylesheet).toBeTruthy();
      const styleHash = createHash("sha256")
        .update(stylesheet ?? "")
        .digest("base64");
      const policy = Object.fromEntries(
        response.headers
          .get("content-security-policy")
          ?.split(";")
          .map((directive) => {
            const [name, ...values] = directive.trim().split(/\s+/);
            return [name, values] as const;
          }) ?? [],
      );
      expect(policy).toMatchObject({
        "default-src": ["'none'"],
        "style-src": [`'sha256-${styleHash}'`],
        "frame-ancestors": ["'none'"],
      });
      expect(policy).not.toHaveProperty("script-src");

      await expectClosed(started.request);
    },
  );

  it("rejects invalid requests without consuming the callback", async () => {
    const started = await start();
    const base = callbackUrl("127.0.0.1", started.port);
    await expectResponse(fetch(`http://127.0.0.1:${started.port}/wrong`), 404);
    await expectResponse(fetch(base, { method: "POST" }), 405);
    for (const query of [
      "?code=code",
      "?code=code&state=wrong",
      `${validQuery}&state=${state}`,
      `${validQuery}&code=second`,
    ]) {
      await expectResponse(started.request(query), 400);
    }
    await expectResponse(started.request(`?code=right&state=${state}`), 200);
    await expect(started.callback.waitForCallback()).resolves.toMatchObject({
      type: "authorization_code",
      code: "right",
    });
  });

  it("flushes a matching-state OAuth error response", async () => {
    const started = await start();
    const responsePromise = started
      .request(`?error=access_denied&error_description=nope&state=${state}`)
      .then(async (response) => ({ status: response.status, body: await response.text() }));

    await expect(started.callback.waitForCallback()).resolves.toEqual({
      type: "oauth_error",
      error: "access_denied",
      errorDescription: "nope",
    });
    await expect(responsePromise).resolves.toEqual({
      status: 400,
      body: expect.stringContaining("Authorization was not completed."),
    });
  });

  it("accepts only one concurrent valid callback", async () => {
    const started = await start();
    const url = callbackUrl("127.0.0.1", started.port, `?code=only-code&state=${state}`);
    const responses = await Promise.allSettled([fetch(url), fetch(url)]);
    const statuses = responses.flatMap((result) =>
      result.status === "fulfilled" ? [result.value.status] : [],
    );
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    await expect(started.callback.waitForCallback()).resolves.toMatchObject({ code: "only-code" });
  });

  it("rejects on timeout and abort and closes the listener", async () => {
    const timedOut = await start();
    await timedOut.callback.close();
    await expect(timedOut.callback.waitForCallback()).rejects.toThrow("cancelled");

    const controller = new AbortController();
    const { callback } = await start("127.0.0.1", { timeoutMs: 30, signal: controller.signal });
    await expect(callback.waitForCallback()).rejects.toThrow("timeout");

    const abortController = new AbortController();
    const { callback: aborted } = await start("127.0.0.1", { signal: abortController.signal });
    abortController.abort();
    await expect(aborted.waitForCallback()).rejects.toThrow("cancelled");
  });

  it("retains provider parameters until browser verification", async () => {
    const started = await start("127.0.0.1", { deferResponse: true });
    const responsePromise = started.request(`${validQuery}&client_id=first&client_id=second`);
    const received = vi.fn();
    void responsePromise.then(received, received);
    const result = await started.callback.waitForCallback();
    expect(result.type).toBe("authorization_code");
    if (result.type !== "authorization_code") {
      throw new Error("Expected authorization code");
    }
    expect(result.parameters.getAll("client_id")).toEqual(["first", "second"]);
    await expectResponse(started.request(`?code=other&state=${state}`), 409);
    expect(received).not.toHaveBeenCalled();
    await started.callback.complete({
      status: 400,
      body: "Provider rejected the registration",
      contentType: "text/plain",
    });
    await expectResponse(responsePromise, 400, "Provider rejected the registration");
  });

  it.each(["abort", "timeout", "browser disconnect"] as const)(
    "releases admitted callbacks on %s",
    async (terminal) => {
      const controller = new AbortController();
      const browser = new AbortController();
      if (terminal === "timeout") {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      const started = await start("127.0.0.1", {
        deferResponse: true,
        signal: terminal === "browser disconnect" ? undefined : controller.signal,
      });
      const responsePromise = started.request(
        validQuery,
        terminal === "browser disconnect" ? { signal: browser.signal } : undefined,
      );
      void responsePromise.catch(() => undefined);
      await started.callback.waitForCallback();
      if (terminal === "timeout") {
        await vi.advanceTimersByTimeAsync(5_000);
        vi.useRealTimers();
      } else if (terminal === "abort") {
        controller.abort();
      } else {
        browser.abort();
      }
      await expect(responsePromise).rejects.toThrow();
      if (terminal === "browser disconnect") {
        await expectClosed(started.request);
      }
      await started.callback.complete({ status: 200, body: "Too late", contentType: "text/plain" });

      const replacement = await openCallback({
        redirectUrl: callbackUrl("127.0.0.1", started.port),
        expectedState: "replacement-state",
        timeoutMs: terminal === "browser disconnect" ? undefined : 5_000,
      });
      await expectResponse(
        fetch(callbackUrl("127.0.0.1", started.port, "?code=new-code&state=replacement-state")),
        200,
      );
      await expect(replacement.waitForCallback()).resolves.toMatchObject({ code: "new-code" });
    },
  );

  it("observes aborts that arrive while localhost resolution is pending", async () => {
    const lookup = createDeferred<LookupAddress[]>();
    lookupMock.mockReturnValueOnce(lookup.promise);
    const controller = new AbortController();
    const port = await getClaimedPort();
    const startPromise = openCallback({
      redirectUrl: `http://localhost:${port}/oauth/callback`,
      signal: controller.signal,
    });
    controller.abort();
    await expect(startPromise).rejects.toThrow("cancelled");
    lookup.resolve([{ address: "127.0.0.1", family: 4 }]);
  });

  it("binds every loopback address resolved for localhost", async () => {
    const port = await getClaimedPort();
    const addresses = [
      ...new Set(
        (await dnsPromises.lookup("localhost", { all: true, verbatim: true })).map(
          (entry) => entry.address,
        ),
      ),
    ];
    const callback = await openCallback({
      redirectUrl: `http://localhost:${port}/oauth/callback`,
      bindHostname: "127.0.0.1",
    });

    for (const address of addresses) {
      await expectResponse(fetch(callbackUrl(address, port, "?code=bad&state=wrong")), 400);
    }
    await expectResponse(
      fetch(callbackUrl(addresses[0]!, port, `?code=right&state=${state}`)),
      200,
    );
    await expect(callback.waitForCallback()).resolves.toMatchObject({ code: "right" });
  });

  it.each([undefined, "localhost"])(
    "uses HTTP port 80 and the exact bind host %s",
    async (bindOnlyHostname) => {
      using listen = vi.spyOn(http.Server.prototype, "listen").mockImplementation(function (
        this: http.Server,
        ...args
      ) {
        const complete = args.at(-1);
        if (typeof complete === "function") {
          complete();
        }
        return this;
      });
      const callback = await openCallback({
        redirectUrl: "http://127.0.0.1/oauth/callback",
        bindOnlyHostname,
      });
      expect(listen).toHaveBeenCalledWith(
        80,
        bindOnlyHostname ?? "127.0.0.1",
        expect.any(Function),
      );
      await callback.close();
    },
  );

  it.each([
    { options: { redirectUrl: "http://127.0.0.1:0/oauth/callback" }, error: "valid TCP port" },
    {
      options: { redirectUrl: "http://localhost:8080/oauth/callback", bindOnlyHostname: "0.0.0.0" },
      error: "OAuth callback bind must use",
    },
    {
      options: {
        redirectUrl: "http://localhost:8989/oauth/callback",
        bindHostname: "127.0.0.1",
      },
      prepare: () => lookupMock.mockResolvedValueOnce([{ address: "203.0.113.1", family: 4 }]),
      error: "exclusively to loopback",
    },
  ])("rejects unsafe loopback configuration: $error", async ({ options, error, prepare }) => {
    prepare?.();
    await expect(openCallback(options)).rejects.toThrow(error);
  });
});
