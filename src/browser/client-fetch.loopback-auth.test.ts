import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserDispatchResponse } from "./routes/dispatcher.js";

function okDispatchResponse(): BrowserDispatchResponse {
  return { status: 200, body: { ok: true } };
}

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({
    gateway: {
      auth: {
        token: "loopback-token",
      },
    },
  })),
  startBrowserControlServiceFromConfig: vi.fn(async () => ({ ok: true })),
  dispatch: vi.fn(async (): Promise<BrowserDispatchResponse> => okDispatchResponse()),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: mocks.loadConfig,
  };
});

vi.mock("./control-service.js", () => ({
  createBrowserControlContext: vi.fn(() => ({})),
  startBrowserControlServiceFromConfig: mocks.startBrowserControlServiceFromConfig,
}));

vi.mock("./routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: vi.fn(() => ({
    dispatch: mocks.dispatch,
  })),
}));

import { fetchBrowserJson } from "./client-fetch.js";

function stubJsonFetchOk() {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("fetchBrowserJson loopback auth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.loadConfig.mockClear();
    mocks.loadConfig.mockReturnValue({
      gateway: {
        auth: {
          token: "loopback-token",
        },
      },
    });
    mocks.startBrowserControlServiceFromConfig.mockReset().mockResolvedValue({ ok: true });
    mocks.dispatch.mockReset().mockResolvedValue(okDispatchResponse());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds bearer auth for loopback absolute HTTP URLs", async () => {
    const fetchMock = stubJsonFetchOk();

    const res = await fetchBrowserJson<{ ok: boolean }>("http://127.0.0.1:18888/");
    expect(res.ok).toBe(true);

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer loopback-token");
  });

  it("does not inject auth for non-loopback absolute URLs", async () => {
    const fetchMock = stubJsonFetchOk();

    await fetchBrowserJson<{ ok: boolean }>("http://example.com/");

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBeNull();
  });

  it("keeps caller-supplied auth header", async () => {
    const fetchMock = stubJsonFetchOk();

    await fetchBrowserJson<{ ok: boolean }>("http://localhost:18888/", {
      headers: {
        Authorization: "Bearer caller-token",
      },
    });

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer caller-token");
  });

  it("injects auth for IPv6 loopback absolute URLs", async () => {
    const fetchMock = stubJsonFetchOk();

    await fetchBrowserJson<{ ok: boolean }>("http://[::1]:18888/");

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer loopback-token");
  });

  it("injects auth for IPv4-mapped IPv6 loopback URLs", async () => {
    const fetchMock = stubJsonFetchOk();

    await fetchBrowserJson<{ ok: boolean }>("http://[::ffff:127.0.0.1]:18888/");

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer loopback-token");
  });

  it("preserves dispatcher error context while keeping no-retry hint", async () => {
    mocks.dispatch.mockRejectedValueOnce(new Error("Chrome CDP handshake timeout"));

    const thrown = await fetchBrowserJson<{ ok: boolean }>("/tabs").catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      throw new Error(`Expected Error, got ${String(thrown)}`);
    }
    expect(thrown.message).toContain("Chrome CDP handshake timeout");
    expect(thrown.message).toContain("Do NOT retry the browser tool");
    expect(thrown.message).not.toContain("Can't reach the OpenClaw browser control service");
  });

  it("surfaces 429 from HTTP URL as rate-limit error with no-retry hint", async () => {
    const response = new Response("max concurrent sessions exceeded", { status: 429 });
    const text = vi.spyOn(response, "text");
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    const thrown = await fetchBrowserJson<{ ok: boolean }>("http://127.0.0.1:18888/").catch(
      (err: unknown) => err,
    );

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      throw new Error(`Expected Error, got ${String(thrown)}`);
    }
    expect(thrown.message).toContain("Browser service rate limit reached");
    expect(thrown.message).toContain("Do NOT retry the browser tool");
    expect(thrown.message).not.toContain("max concurrent sessions exceeded");
    expect(text).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("surfaces 429 from HTTP URL without body detail when empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 429 })),
    );

    const thrown = await fetchBrowserJson<{ ok: boolean }>("http://127.0.0.1:18888/").catch(
      (err: unknown) => err,
    );

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      throw new Error(`Expected Error, got ${String(thrown)}`);
    }
    expect(thrown.message).toContain("rate limit reached");
    expect(thrown.message).toContain("Do NOT retry the browser tool");
  });

  it("keeps Browserbase-specific wording for Browserbase 429 responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("max concurrent sessions exceeded", { status: 429 })),
    );

    const thrown = await fetchBrowserJson<{ ok: boolean }>(
      "https://connect.browserbase.com/session",
    ).catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      throw new Error(`Expected Error, got ${String(thrown)}`);
    }
    expect(thrown.message).toContain("Browserbase rate limit reached");
    expect(thrown.message).toContain("upgrade your plan");
    expect(thrown.message).not.toContain("max concurrent sessions exceeded");
  });

  it("non-429 errors still produce generic messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("internal error", { status: 500 })),
    );

    const thrown = await fetchBrowserJson<{ ok: boolean }>("http://127.0.0.1:18888/").catch(
      (err: unknown) => err,
    );

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      throw new Error(`Expected Error, got ${String(thrown)}`);
    }
    expect(thrown.message).toContain("internal error");
    expect(thrown.message).not.toContain("rate limit");
  });

  it("surfaces 429 from dispatcher path as rate-limit error", async () => {
    mocks.dispatch.mockResolvedValueOnce({
      status: 429,
      body: { error: "too many sessions" },
    });

    const thrown = await fetchBrowserJson<{ ok: boolean }>("/tabs").catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      throw new Error(`Expected Error, got ${String(thrown)}`);
    }
    expect(thrown.message).toContain("Browser service rate limit reached");
    expect(thrown.message).toContain("Do NOT retry the browser tool");
    expect(thrown.message).not.toContain("too many sessions");
  });

  it("keeps absolute URL failures wrapped as reachability errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    );

    const thrown = await fetchBrowserJson<{ ok: boolean }>("http://example.com/").catch(
      (err: unknown) => err,
    );

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      throw new Error(`Expected Error, got ${String(thrown)}`);
    }
    expect(thrown.message).toContain("Can't reach the OpenClaw browser control service");
    expect(thrown.message).toContain("Do NOT retry the browser tool");
  });
});
