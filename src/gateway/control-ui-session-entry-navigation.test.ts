import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { sessionNavigationTarget } from "../../ui/src/lib/sessions/route-navigation.ts";

const workerSource = readFileSync(new URL("../../ui/public/sw.js", import.meta.url), "utf8");

function navigationWorker(basePath = "", proxySessionEntry = true) {
  const scope = `https://gateway.test${basePath}/`;
  const listeners = new Map<string, (event: unknown) => void>();
  const document = new Response("public conversation");
  const fetch = vi.fn<typeof globalThis.fetch>();
  const source = workerSource.replace(
    "const OFFLINE_BOOT = null;",
    `const OFFLINE_BOOT = ${JSON.stringify({
      id: "navigation-fixture",
      routes: ["/chat", "/new"],
      routePrefixes: ["/chat/"],
      publicAssets: [],
    })};`,
  );
  runInNewContext(source, {
    URL,
    Response,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch,
    self: {
      location: { href: `${scope}sw.js${proxySessionEntry ? "?session-entry=1" : ""}` },
      registration: { scope },
      navigator: { onLine: true },
      addEventListener: (name: string, listener: (event: unknown) => void) =>
        listeners.set(name, listener),
    },
  });
  return {
    fetch,
    document,
    navigate(path: string) {
      let response: Promise<Response> | undefined;
      listeners.get("fetch")!({
        request: {
          url: new URL(path, scope).href,
          method: "GET",
          mode: "navigate",
          signal: new AbortController().signal,
        },
        respondWith: (value: Promise<Response>) => {
          response = value;
        },
      });
      return response;
    },
  };
}

describe("operator browser chat document navigation", () => {
  it.each(["", "/control"])(
    "reloads in-app session navigation hints under %s",
    async (basePath) => {
      const worker = navigationWorker(basePath);
      const sessionKey = "agent:main:dashboard:12345678-aaaa-4000-8000-000000000001";
      const target = sessionNavigationTarget({
        face: "chat",
        sessionKey,
        navigationKey: sessionKey,
        focusComposer: true,
        preferenceDerivedFace: true,
        fallbackAgentId: "main",
        basePath,
      });
      const path = target.options.pathname + target.options.search;
      const app = new Response("app", { headers: { "X-OpenClaw-Session-Entry": "1" } });
      worker.fetch.mockResolvedValueOnce(app);
      expect(await worker.navigate(path)).toBe(app);
      expect(worker.fetch).toHaveBeenCalledExactlyOnceWith(
        `https://gateway.test${basePath}/__openclaw__/session-entry?${new URLSearchParams({ path })}`,
        expect.objectContaining({
          credentials: "same-origin",
          redirect: "manual",
          cache: "no-store",
        }),
      );
    },
  );

  it.each(["", "/control"])("loads one protected app document under %s", async (basePath) => {
    const worker = navigationWorker(basePath);
    const path = `${basePath}/chat/main/dashboard/12345678-aaaa-4000-8000-000000000001?dashboard=expanded&openclaw_mount_recovery=1791731984160`;
    const app = new Response("app", {
      headers: { "Content-Type": "text/html", "X-OpenClaw-Session-Entry": "1" },
    });
    worker.fetch.mockResolvedValueOnce(app);
    expect(await worker.navigate(path)).toBe(app);
    expect(worker.fetch).toHaveBeenCalledExactlyOnceWith(
      `https://gateway.test${basePath}/__openclaw__/session-entry?${new URLSearchParams({ path })}`,
      expect.objectContaining({
        credentials: "same-origin",
        redirect: "manual",
        cache: "no-store",
      }),
    );
  });

  it.each([401, 403, 303, 200, 503, "network"])(
    "falls back to the public document without following an entry %s",
    async (result) => {
      const worker = navigationWorker();
      if (result === "network") {
        worker.fetch.mockRejectedValueOnce(new TypeError("Offline"));
      } else {
        worker.fetch.mockResolvedValueOnce(new Response("not app", { status: Number(result) }));
      }
      worker.fetch.mockResolvedValueOnce(worker.document);
      expect(await worker.navigate("/chat/main/topic")).toBe(worker.document);
      expect(worker.fetch).toHaveBeenCalledTimes(2);
      expect(worker.fetch.mock.calls[1]?.[0]).toMatchObject({
        url: "https://gateway.test/chat/main/topic",
      });
    },
  );

  it("keeps an agent-selector reload on the protected session entry", async () => {
    const worker = navigationWorker();
    const path = "/chat/new-bot?__openclawSessionFacePreference=1";
    const app = new Response("app", { headers: { "X-OpenClaw-Session-Entry": "1" } });
    worker.fetch.mockResolvedValueOnce(app);
    expect(await worker.navigate(path)).toBe(app);
    expect(worker.fetch).toHaveBeenCalledExactlyOnceWith(
      `https://gateway.test/__openclaw__/session-entry?${new URLSearchParams({ path })}`,
      expect.objectContaining({ credentials: "same-origin", redirect: "manual" }),
    );
  });

  it("leaves the browser a native navigation when the public route also challenges", async () => {
    const worker = navigationWorker();
    worker.fetch.mockResolvedValue(
      new Response("Sign in", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="synthetic"' },
      }),
    );
    const response = await worker.navigate("/chat/main/topic");
    expect(response?.status).toBe(302);
    expect(response?.headers.get("Location")).toBe(
      "https://gateway.test/__openclaw__/session-entry?path=%2Fchat%2Fmain%2Ftopic",
    );
    expect(worker.navigate(response!.headers.get("Location")!)).toBeUndefined();
  });

  it.each([
    ["/chat/main/topic", false],
    ["/", true],
    ["/chat", true],
    ["/chat/", true],
    ["/new", true],
    ["/chat/main/topic?offset=100", true],
    ["/chat/main/topic?openclaw_mount_recovery=1&token=secret", true],
    ["/chat/main/topic?openclaw_mount_recovery=1&unknown=value", true],
    ["/chat/main?catalog=x&host=y&thread=z", true],
    ["/chat/main?__openclawSessionKey=first&__openclawSessionKey=second", true],
    ["/chat/main?__openclawSessionKey=", true],
    ["/chat/main?__openclawSessionKey=+%20", true],
    ["/chat/main?__openclawSessionKey=agent%3Amain%3Aa%00", true],
    ["/chat/main?__openclawSessionKey=agent%3Amain%3Aa%1F", true],
    ["/chat/main?__openclawSessionKey=agent%3Amain%3Aa%7F", true],
    ["/chat/main?__openclawSessionKey=agent%3Amain%3Aa&token=secret", true],
    ["/chat/main?__openclawSessionKey=agent%3Amain%3Aa&unknown=value", true],
    ["/chat/main?__openclawComposerFocus=1&__openclawComposerFocus=1", true],
    ["/chat/main?__openclawComposerFocus=0", true],
    ["/chat/main?__openclawComposerFocus=", true],
  ] as const)(
    "fetches %s without rewriting it to a protected session entry",
    async (path, proxy) => {
      const worker = navigationWorker("", proxy);
      worker.fetch.mockResolvedValueOnce(worker.document);
      expect(await worker.navigate(path)).toBe(worker.document);
      expect(worker.fetch).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ url: `https://gateway.test${path}` }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    },
  );

  it.each([
    "/__openclaw__/session-entry?path=%2Fchat%2Fmain%2Ftopic",
    "https://other.test/chat/main/topic",
  ])("preserves native navigation for %s", (path) => {
    const worker = navigationWorker();
    expect(worker.navigate(path)).toBeUndefined();
    expect(worker.fetch).not.toHaveBeenCalled();
  });
});
