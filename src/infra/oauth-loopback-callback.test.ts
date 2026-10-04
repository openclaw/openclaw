import { createHash } from "node:crypto";
import type { LookupAddress } from "node:dns";
import * as dnsPromises from "node:dns/promises";
import type { Server } from "node:http";
import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { oauthSuccessHtml } from "../plugin-sdk/provider-oauth-runtime.js";
import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import { hasErrnoCode } from "./errno.js";
import {
  startOAuthLoopbackCallbackServer,
  type OAuthLoopbackCallbackServer,
} from "./oauth-loopback-callback.js";

const openCallbacks: OAuthLoopbackCallbackServer[] = [];
const portClaims: TestPortClaim[] = [];

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

async function getClaimedIpv6Port(): Promise<number | undefined> {
  const port = await getClaimedPort();
  const probe = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "::1", resolve);
    });
    return port;
  } catch (error) {
    if (hasErrnoCode(error, "EADDRNOTAVAIL") || hasErrnoCode(error, "EAFNOSUPPORT")) {
      return undefined;
    }
    throw error;
  } finally {
    await new Promise<void>((resolve) => {
      probe.close(() => resolve());
    });
  }
}

async function start(
  hostname = "127.0.0.1",
  options: Partial<Parameters<typeof startOAuthLoopbackCallbackServer>[0]> = {},
  requestedPort?: number,
) {
  const port = requestedPort ?? (await getClaimedPort());
  const callback = await startOAuthLoopbackCallbackServer({
    redirectUrl: callbackUrl(hostname, port),
    expectedState: "state-1234567890",
    timeoutMs: 5_000,
    ...options,
  });
  openCallbacks.push(callback);
  return { callback, port };
}

describe("OAuth loopback callback server", () => {
  it.each(["default", "provider", "ipv6"] as const)(
    "serves a styled %s response permitted by CSP before closing",
    async (renderer) => {
      const hostname = renderer === "ipv6" ? "::1" : "127.0.0.1";
      const ipv6Port = renderer === "ipv6" ? await getClaimedIpv6Port() : undefined;
      if (renderer === "ipv6" && !ipv6Port) {
        return;
      }
      const code = renderer === "ipv6" ? "ipv6" : "authorization-code";
      const query = `code=${code}&state=state-1234567890`;
      const started = await start(
        hostname,
        {
          renderSuccess:
            renderer === "provider"
              ? () => ({
                  body: oauthSuccessHtml(
                    "Authorization received; return to the terminal while OpenClaw finishes.",
                  ),
                  contentType: "text/html; charset=utf-8",
                })
              : undefined,
        },
        ipv6Port,
      );
      const responsePromise = fetch(callbackUrl(hostname, started.port, `?${query}`)).then(
        async (response) => ({
          status: response.status,
          body: await response.text(),
          headers: response.headers,
        }),
      );

      await expect(started.callback.waitForCallback()).resolves.toEqual({
        type: "authorization_code",
        code,
        state: "state-1234567890",
        parameters: new URLSearchParams(query),
      });
      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(response.body).toContain("Authorization received");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const stylesheet = /<style>([\s\S]*?)<\/style>/.exec(response.body)?.[1];
      expect(stylesheet).toBeTruthy();
      const styleHash = createHash("sha256")
        .update(stylesheet ?? "")
        .digest("base64");
      const policy = new Map(
        response.headers
          .get("content-security-policy")
          ?.split(";")
          .map((directive) => {
            const [name, ...values] = directive.trim().split(/\s+/);
            return [name, values] as const;
          }),
      );
      expect(policy.get("default-src")).toEqual(["'none'"]);
      expect(policy.get("style-src")).toEqual([`'sha256-${styleHash}'`]);
      expect(policy.has("script-src")).toBe(false);
      expect(policy.get("frame-ancestors")).toEqual(["'none'"]);

      await vi.waitFor(async () => {
        await expect(fetch(callbackUrl(hostname, started.port))).rejects.toThrow();
      });
    },
  );

  it("keeps waiting after wrong path, method, missing state, and ambiguous or wrong callback fields", async () => {
    const started = await start();
    const base = callbackUrl("127.0.0.1", started.port);
    expect((await fetch(`http://127.0.0.1:${started.port}/wrong`)).status).toBe(404);
    expect((await fetch(base, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}?code=code`)).status).toBe(400);
    expect((await fetch(`${base}?code=code&state=wrong`)).status).toBe(400);
    expect(
      (await fetch(`${base}?code=code&state=state-1234567890&state=state-1234567890`)).status,
    ).toBe(400);
    expect((await fetch(`${base}?code=first&code=second&state=state-1234567890`)).status).toBe(400);

    const response = await fetch(`${base}?code=right&state=state-1234567890`);
    expect(response.status).toBe(200);
    await response.text();
    await expect(started.callback.waitForCallback()).resolves.toMatchObject({
      type: "authorization_code",
      code: "right",
    });
  });

  it("settles a matching-state OAuth error after flushing its response", async () => {
    const started = await start();
    const responsePromise = fetch(
      callbackUrl(
        "127.0.0.1",
        started.port,
        "?error=access_denied&error_description=nope&state=state-1234567890",
      ),
    ).then(async (response) => ({ status: response.status, body: await response.text() }));

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
    const url = callbackUrl("127.0.0.1", started.port, "?code=only-code&state=state-1234567890");
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
    const { callback } = await start("127.0.0.1", {
      timeoutMs: 30,
      signal: controller.signal,
    });
    await expect(callback.waitForCallback()).rejects.toThrow("timeout");

    const abortController = new AbortController();
    const { callback: aborted } = await start("127.0.0.1", {
      signal: abortController.signal,
    });
    abortController.abort();
    await expect(aborted.waitForCallback()).rejects.toThrow("cancelled");
  });

  it("retains provider callback parameters and waits for the verified browser outcome", async () => {
    const started = await start("127.0.0.1", { deferResponse: true });
    const responsePromise = fetch(
      callbackUrl(
        "127.0.0.1",
        started.port,
        "?code=code&state=state-1234567890&client_id=first&client_id=second",
      ),
    );
    const received = vi.fn();
    void responsePromise.then(received, received);
    const result = await started.callback.waitForCallback();
    expect(result.type).toBe("authorization_code");
    if (result.type !== "authorization_code") {
      throw new Error("Expected authorization code");
    }
    expect(result.parameters.getAll("client_id")).toEqual(["first", "second"]);
    expect(
      (await fetch(callbackUrl("127.0.0.1", started.port, "?code=other&state=state-1234567890")))
        .status,
    ).toBe(409);
    expect(received).not.toHaveBeenCalled();
    await started.callback.complete({
      status: 400,
      body: "Provider rejected the registration",
      contentType: "text/plain",
    });
    const response = await responsePromise;
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Provider rejected the registration");
  });

  it.each(["abort", "timeout", "browser disconnect"] as const)(
    "releases an admitted callback on %s before provider work completes",
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
      const responsePromise = fetch(
        callbackUrl("127.0.0.1", started.port, "?code=code&state=state-1234567890"),
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
        await vi.waitFor(async () => {
          await expect(fetch(callbackUrl("127.0.0.1", started.port))).rejects.toThrow();
        });
      }
      await started.callback.complete({ status: 200, body: "Too late", contentType: "text/plain" });

      const replacement = await startOAuthLoopbackCallbackServer({
        redirectUrl: callbackUrl("127.0.0.1", started.port),
        expectedState: "replacement-state",
        timeoutMs: terminal === "browser disconnect" ? undefined : 5_000,
      });
      openCallbacks.push(replacement);
      const response = await fetch(
        callbackUrl("127.0.0.1", started.port, "?code=new-code&state=replacement-state"),
      );
      expect(response.status).toBe(200);
      await response.text();
      await expect(replacement.waitForCallback()).resolves.toMatchObject({ code: "new-code" });
    },
  );

  it("observes aborts that arrive while localhost resolution is pending", async () => {
    let releaseLookup!: () => void;
    const pendingLookup = new Promise<LookupAddress[]>((resolve) => {
      releaseLookup = () => resolve([{ address: "127.0.0.1", family: 4 }]);
    });
    const controller = new AbortController();
    const port = await getClaimedPort();
    const startPromise = startOAuthLoopbackCallbackServer({
      redirectUrl: `http://localhost:${port}/oauth/callback`,
      expectedState: "state-1234567890",
      timeoutMs: 5_000,
      signal: controller.signal,
      lookup: () => pendingLookup,
    });
    controller.abort();
    await expect(startPromise).rejects.toThrow("cancelled");
    releaseLookup();
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
    const callback = await startOAuthLoopbackCallbackServer({
      redirectUrl: `http://localhost:${port}/oauth/callback`,
      bindHostname: "127.0.0.1",
      expectedState: "state-1234567890",
      timeoutMs: 5_000,
    });
    openCallbacks.push(callback);

    for (const address of addresses) {
      const response = await fetch(callbackUrl(address, port, "?code=bad&state=wrong"));
      expect(response.status).toBe(400);
    }
    const response = await fetch(
      callbackUrl(addresses[0]!, port, "?code=right&state=state-1234567890"),
    );
    expect(response.status).toBe(200);
    await response.text();
    await expect(callback.waitForCallback()).resolves.toMatchObject({ code: "right" });
  });

  it.each([undefined, "localhost"])(
    "uses HTTP port 80 and the exact bind host %s",
    async (bindOnlyHostname) => {
      let observedPort: number | undefined;
      let observedHostname: string | undefined;
      const fakeServer = {
        listening: false,
        once: () => fakeServer,
        listen: (port: number, hostname: string, callback: () => void) => {
          observedPort = port;
          observedHostname = hostname;
          fakeServer.listening = true;
          callback();
          return fakeServer;
        },
        removeAllListeners: () => fakeServer,
        on: () => fakeServer,
        close: (callback: () => void) => {
          fakeServer.listening = false;
          callback();
          return fakeServer;
        },
        closeAllConnections: () => undefined,
      };
      const callback = await startOAuthLoopbackCallbackServer({
        redirectUrl: "http://127.0.0.1/oauth/callback",
        bindOnlyHostname,
        expectedState: "state-1234567890",
        timeoutMs: 5_000,
        createServer: (() =>
          fakeServer as unknown as Server) as typeof import("node:http").createServer,
      });
      expect(observedPort).toBe(80);
      expect(observedHostname).toBe(bindOnlyHostname ?? "127.0.0.1");
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
        lookup: async () => [{ address: "203.0.113.1", family: 4 }],
      },
      error: "exclusively to loopback",
    },
  ])("rejects unsafe loopback configuration: $error", async ({ options, error }) => {
    await expect(
      startOAuthLoopbackCallbackServer({
        ...options,
        expectedState: "state-1234567890",
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(error);
  });
});
