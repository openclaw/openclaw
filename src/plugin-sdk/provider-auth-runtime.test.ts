import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  saveAuthProfileStore,
  updateAuthProfileStoreWithLock,
} from "../agents/auth-profiles/store-runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as auth from "./provider-auth-runtime.js";

const callbackListener = vi.hoisted(
  (): { port?: number; servers: import("node:http").Server[] } => ({ servers: [] }),
);

vi.mock("node:http", async (importOriginal) => {
  const http = await importOriginal<typeof import("node:http")>();
  class CallbackServer extends http.Server {
    override listen(...args: unknown[]): this {
      const [port, hostname, onListening] = args;
      expect(port).toBe(61040);
      if (typeof hostname !== "string" || typeof onListening !== "function") {
        throw new Error("Expected a TCP callback listener and readiness callback");
      }
      // Bind once on the kernel-assigned port; a closed probe leaves a handoff race.
      // Additional localhost addresses must keep that same port.
      return super.listen(callbackListener.port ?? 0, hostname, () => {
        const address = this.address();
        if (!address || typeof address === "string") {
          throw new Error("Expected a bound TCP callback listener");
        }
        callbackListener.port = address.port;
        onListening();
      });
    }
  }
  return {
    ...http,
    createServer: (...args: ConstructorParameters<typeof CallbackServer>) => {
      const server = new CallbackServer(...args);
      callbackListener.servers.push(server);
      return server;
    },
  };
});

const callbacks: Array<{ controller: AbortController; settled: Promise<void> }> = [];

afterEach(async () => {
  const pending = callbacks.splice(0);
  for (const { controller } of pending) {
    controller.abort();
  }
  await Promise.all(pending.map(({ settled }) => settled));
  callbackListener.port = undefined;
  callbackListener.servers.length = 0;
});

function startCallback(
  params: Partial<
    Omit<Parameters<typeof auth.waitForLocalOAuthCallback>[0], "signal" | "port" | "redirectUri">
  > = {},
  controller = new AbortController(),
) {
  const { promise: ready, resolve, reject } = createDeferredCore<number>();
  const callback = auth.waitForLocalOAuthCallback({
    expectedState: "state-1",
    timeoutMs: 5_000,
    callbackPath: "/callback",
    successTitle: "OAuth complete",
    ...params,
    port: 61040,
    redirectUri: "http://127.0.0.1:61040/callback",
    signal: controller.signal,
    onProgress: (message) => {
      if (callbackListener.port === undefined) {
        throw new Error("Callback readiness requires a bound listener");
      }
      resolve(callbackListener.port);
      params.onProgress?.(message);
    },
  });
  callbacks.push({ controller, settled: callback.then(() => undefined, reject) });
  // Cancellation does not await readiness; startup failure must still be observed.
  void ready.catch(() => undefined);
  return { callback, ready };
}

function callbackUrl(port: number) {
  return `http://127.0.0.1:${port}/callback`;
}
function finishCallback(port: number, origin?: string) {
  return fetch(
    `${callbackUrl(port)}?code=code-1&state=state-1`,
    origin ? { headers: { Origin: origin } } : {},
  );
}
function preflight(port: number, origin: string, privateNetwork = true) {
  return fetch(callbackUrl(port), {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "GET",
      ...(privateNetwork
        ? {
            "Access-Control-Request-Headers": "content-type",
            "Access-Control-Request-Private-Network": "true",
          }
        : {}),
    },
  });
}

describe("plugin-sdk provider-auth-runtime", () => {
  it("exports the runtime-ready auth helper", () => {
    expect(auth.getRuntimeAuthForModel).toBeTypeOf("function");
  });

  it("resolves non-secret provider auth profile metadata", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "provider-auth-runtime-"));
    const agentDir = path.join(tempRoot, "agent");
    const credential = {
      type: "oauth" as const,
      provider: "openai",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      accountId: "acct-openai-workspace",
    };
    saveAuthProfileStore({ version: 1, profiles: { "openai:chatgpt": credential } }, agentDir);

    const params = { provider: "openai", profileId: "openai:chatgpt", agentDir };
    const expected = { profileId: "openai:chatgpt", accountId: "acct-openai-workspace" };
    expect(auth.resolveProviderAuthProfileMetadata(params)).toEqual(expected);
    await expect(auth.resolveProviderAuthProfileMetadataAsync(params)).resolves.toEqual(expected);
    await updateAuthProfileStoreWithLock({
      agentDir,
      updater(store) {
        const profile = store.profiles["openai:chatgpt"];
        if (profile?.type === "oauth") {
          profile.accountId = "acct-updated-workspace";
        }
        return true;
      },
    });
    await expect(auth.resolveProviderAuthProfileMetadataAsync(params)).resolves.toEqual({
      profileId: "openai:chatgpt",
      accountId: "acct-updated-workspace",
    });
  });

  it("generates random OAuth state tokens", () => {
    const first = auth.generateOAuthState();
    const second = auth.generateOAuthState();

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toMatch(/^[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
  });

  it("parses OAuth callback URLs and rejects bare codes", () => {
    expect(
      auth.parseOAuthCallbackInput("http://127.0.0.1:3000/callback?code=abc&state=state-1"),
    ).toEqual({ code: "abc", state: "state-1" });
    expect(auth.parseOAuthCallbackInput("abc")).toEqual({
      error: "Paste the full redirect URL, not just the code.",
    });
  });

  it.each([
    ["allowlisted", "https://auth.x.ai", ["auth.x.ai", "accounts.x.ai"], undefined],
    ["rejected", "https://attacker.example", ["auth.x.ai"], "127.0.0.1"],
    ["legacy", "https://legacy.example", undefined, "127.0.0.1"],
  ] as const)(
    "handles %s callback CORS and keeps waiting for login",
    async (policy, origin, allowlist, hostname) => {
      const { callback, ready } = startCallback({
        hostname,
        corsOriginAllowlist: allowlist,
        successTitle: `OAuth <complete>&"'`,
      });
      const port = await ready;
      const probe = await preflight(port, origin, policy !== "legacy");
      expect(probe.status).toBe(204);
      expect(probe.headers.get("access-control-allow-origin")).toBe(
        policy === "rejected" ? null : origin,
      );
      if (policy === "rejected") {
        expect(
          ["methods", "headers", "private-network"].map((name) =>
            probe.headers.get(`access-control-allow-${name}`),
          ),
        ).toEqual([null, null, null]);
      } else {
        expect(probe.headers.get("access-control-allow-methods")).toContain("GET");
        if (policy === "allowlisted") {
          expect(probe.headers.get("access-control-allow-private-network")).toBe("true");
        }
      }
      const response = await finishCallback(
        port,
        policy === "legacy" ? undefined : "https://auth.x.ai",
      );
      expect(response.status).toBe(200);
      if (policy !== "legacy") {
        expect(response.headers.get("access-control-allow-origin")).toBe("https://auth.x.ai");
      }
      await expect(response.text()).resolves.toContain("OAuth &lt;complete&gt;&amp;&quot;&#39;");
      await expect(callback).resolves.toEqual({ code: "code-1", state: "state-1" });
    },
  );

  it("closes a pending localhost callback when its owner cancels", async () => {
    const controller = new AbortController();
    const { callback } = startCallback({ hostname: "127.0.0.1" }, controller);

    controller.abort();

    await expect(callback).rejects.toThrow("OAuth callback cancelled");
  });

  it("closes the localhost listener when progress reporting throws", async () => {
    const failure = new Error("Progress reporter failed");
    const { callback } = startCallback({
      onProgress: () => {
        throw failure;
      },
    });

    await expect(callback).rejects.toBe(failure);
    expect(callbackListener.servers).toHaveLength(1);
    expect(callbackListener.servers[0]?.listening).toBe(false);
  });

  it("keeps an explicit localhost bind compatible with an IPv4 redirect", async () => {
    const { callback, ready } = startCallback({
      expectedState: "state-1",
      timeoutMs: 5_000,
      callbackPath: "/callback",
      hostname: "localhost",
      successTitle: "OAuth complete",
    });

    const port = await ready;
    const response = await fetch(`http://127.0.0.1:${port}/callback?code=code-1&state=state-1`);
    expect(response.status).toBe(200);
    await expect(callback).resolves.toEqual({ code: "code-1", state: "state-1" });
  });
  it("clamps oversized OAuth callback timeouts before scheduling", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const { callback, ready } = startCallback({
        timeoutMs: Number.MAX_SAFE_INTEGER,
        hostname: "127.0.0.1",
      });
      const port = await ready;

      const response = await finishCallback(port);

      expect(response.status).toBe(200);
      await expect(callback).resolves.toEqual({ code: "code-1", state: "state-1" });
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});

describe("buildOAuthCallbackOriginResolver", () => {
  it("returns a no-op resolver when no allowlist is provided", () => {
    const values = [undefined, [], ["", "  "]].map((hosts) =>
      auth.buildOAuthCallbackOriginResolver(hosts)("https://auth.example.com"),
    );
    expect(values).toEqual([undefined, undefined, undefined]);
  });

  it("echoes only allowlisted hosts and only over https", () => {
    const resolver = auth.buildOAuthCallbackOriginResolver([
      "auth.example.com",
      "ACCOUNTS.example.com",
    ]);

    expect(resolver("https://auth.example.com")).toBe("https://auth.example.com");
    expect(resolver("https://accounts.example.com")).toBe("https://accounts.example.com");
    expect(resolver("https://AUTH.EXAMPLE.COM")).toBe("https://auth.example.com");
    expect(resolver("https://attacker.example.com")).toBeUndefined();
    expect(resolver("http://auth.example.com")).toBeUndefined();
    expect(resolver("not a url")).toBeUndefined();
    expect(resolver(undefined)).toBeUndefined();
    expect(resolver([])).toBeUndefined();
    expect(resolver(["https://auth.example.com", "https://attacker.example.com"])).toBe(
      "https://auth.example.com",
    );
    expect(resolver(["https://attacker.example.com", "https://auth.example.com"])).toBeUndefined();
  });
});
