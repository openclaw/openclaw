import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({
    gateway: {
      auth: {
        token: "loopback-token",
      },
    },
  })),
  startBrowserControlServiceFromConfig: vi.fn(async () => ({ ok: true })),
  dispatch: vi.fn(async () => ({ status: 200, body: { ok: true } })),
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
    mocks.dispatch.mockReset().mockResolvedValue({ status: 200, body: { ok: true } });
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
