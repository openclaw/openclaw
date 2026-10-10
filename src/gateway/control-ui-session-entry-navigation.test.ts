import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const workerSource = readFileSync(new URL("../../ui/public/sw.js", import.meta.url), "utf8");

function navigationWorker(basePath = "", proxySessionEntry = true) {
  const scope = `https://gateway.test${basePath}/`;
  const listeners = new Map<string, (event: unknown) => void>();
  const fetch = vi.fn<typeof globalThis.fetch>();
  runInNewContext(workerSource, {
    URL,
    Response,
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
  it("leaves token/password deployments on the existing public-reader credential handoff", () => {
    const worker = navigationWorker("", false);
    expect(worker.navigate("/chat/main/topic")).toBeUndefined();
    expect(worker.fetch).not.toHaveBeenCalled();
  });
  it.each(["", "/control"])("loads one protected app document under %s", async (basePath) => {
    const worker = navigationWorker(basePath);
    const path = `${basePath}/chat/main/dashboard/12345678-aaaa-4000-8000-000000000001?dashboard=expanded`;
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
      const publicDocument = new Response("public conversation");
      worker.fetch.mockResolvedValueOnce(publicDocument);
      expect(await worker.navigate("/chat/main/topic")).toBe(publicDocument);
      expect(worker.fetch).toHaveBeenCalledTimes(2);
      expect(worker.fetch.mock.calls[1]?.[0]).toMatchObject({
        url: "https://gateway.test/chat/main/topic",
      });
    },
  );

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
    "/",
    "/chat",
    "/chat/",
    "/new",
    "/__openclaw__/session-entry?path=%2Fchat%2Fmain%2Ftopic",
    "/chat/main/topic?offset=100",
    "/chat/main?catalog=x&host=y&thread=z",
    "https://other.test/chat/main/topic",
  ])("preserves native navigation for %s", (path) => {
    const worker = navigationWorker();
    expect(worker.navigate(path)).toBeUndefined();
    expect(worker.fetch).not.toHaveBeenCalled();
  });
});
