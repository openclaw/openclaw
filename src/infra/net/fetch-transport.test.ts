// App fetch transport tests cover non-SSRF redirect, timeout, cleanup, and dispatcher mechanics.
import { readResponseWithLimit } from "@openclaw/media-core/read-response-with-limit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithAppNetworkTransport, type AppFetchTransportOptions } from "./fetch-transport.js";

function makeCancelableBody() {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("redirect"));
    },
    cancel,
  });
  return { body, cancel };
}

function headersRecord(init: RequestInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

async function readTestResponseText(response: Response): Promise<string> {
  return (await readResponseWithLimit(response, 64)).toString("utf8");
}

describe("fetchWithAppNetworkTransport", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("follows redirects and cancels replaced response bodies", async () => {
    const firstBody = makeCancelableBody();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(firstBody.body, {
          status: 302,
          headers: { location: "https://example.com/final" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const result = await fetchWithAppNetworkTransport({
      url: "https://example.com/start",
      fetchImpl,
      maxRedirects: 2,
    });

    try {
      expect(result.finalUrl).toBe("https://example.com/final");
      await expect(readTestResponseText(result.response)).resolves.toBe("ok");
      expect(firstBody.cancel).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
        "https://example.com/start",
        "https://example.com/final",
      ]);
    } finally {
      await result.release();
    }
  });

  it("rejects redirect loops and redirect limit overflows after canceling redirect bodies", async () => {
    const loopBody = makeCancelableBody();
    const loopFetch = vi.fn(
      async () =>
        new Response(loopBody.body, {
          status: 302,
          headers: { location: "https://example.com/start" },
        }),
    );

    await expect(
      fetchWithAppNetworkTransport({
        url: "https://example.com/start",
        fetchImpl: loopFetch,
        maxRedirects: 3,
      }),
    ).rejects.toThrow("Redirect loop detected");
    expect(loopBody.cancel).toHaveBeenCalledTimes(1);

    const limitBody = makeCancelableBody();
    const limitFetch = vi.fn(
      async () =>
        new Response(limitBody.body, {
          status: 302,
          headers: { location: "https://example.com/next" },
        }),
    );

    await expect(
      fetchWithAppNetworkTransport({
        url: "https://example.com/start",
        fetchImpl: limitFetch,
        maxRedirects: 0,
      }),
    ).rejects.toThrow("Too many redirects (limit: 0)");
    expect(limitBody.cancel).toHaveBeenCalledTimes(1);
  });

  it("rewrites unsafe methods and strips sensitive headers across cross-origin redirects", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: "https://other.example/final" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const result = await fetchWithAppNetworkTransport({
      url: "https://source.example/start",
      fetchImpl,
      init: {
        method: "POST",
        body: "secret-body",
        headers: {
          authorization: "Bearer secret",
          cookie: "sid=secret",
          "content-type": "text/plain",
          "user-agent": "OpenClaw Test",
        },
      },
    });

    try {
      const redirectedInit = fetchImpl.mock.calls[1]?.[1] as RequestInit | undefined;
      expect(redirectedInit?.method).toBe("GET");
      expect(redirectedInit?.body).toBeUndefined();
      const headers = headersRecord(redirectedInit);
      expect(headers.authorization).toBeUndefined();
      expect(headers.cookie).toBeUndefined();
      expect(headers["content-type"]).toBeUndefined();
      expect(headers["user-agent"]).toBe("OpenClaw Test");
    } finally {
      await result.release();
    }
  });

  it("preserves unsafe cross-origin replay only when explicitly allowed", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: "https://other.example/final" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const result = await fetchWithAppNetworkTransport({
      url: "https://source.example/start",
      fetchImpl,
      allowCrossOriginUnsafeRedirectReplay: true,
      init: {
        method: "POST",
        body: "safe-by-caller-contract",
        headers: { authorization: "Bearer secret" },
      },
    });

    try {
      const redirectedInit = fetchImpl.mock.calls[1]?.[1] as RequestInit | undefined;
      expect(redirectedInit?.method).toBe("POST");
      expect(redirectedInit?.body).toBe("safe-by-caller-contract");
      expect(headersRecord(redirectedInit).authorization).toBeUndefined();
    } finally {
      await result.release();
    }
  });

  it("validates redirect targets before fetching them", async () => {
    const redirectBody = makeCancelableBody();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(redirectBody.body, {
          status: 302,
          headers: { location: "https://blocked.example/final" },
        }),
      )
      .mockResolvedValueOnce(new Response("should not be fetched", { status: 200 }));
    const validateUrl = vi.fn((url: URL) => {
      if (url.hostname !== "allowed.example") {
        throw new Error(`blocked by test allowlist: ${url.hostname}`);
      }
    });

    await expect(
      fetchWithAppNetworkTransport({
        url: "https://allowed.example/start",
        fetchImpl,
        maxRedirects: 2,
        validateUrl,
      }),
    ).rejects.toThrow("blocked by test allowlist: blocked.example");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://allowed.example/start");
    expect(validateUrl.mock.calls.map(([url]) => url.hostname)).toEqual([
      "allowed.example",
      "blocked.example",
    ]);
    expect(redirectBody.cancel).toHaveBeenCalledTimes(1);
  });

  it("notifies redirect observers before redirect limit rejection", async () => {
    const redirectBody = makeCancelableBody();
    const fetchImpl = vi.fn(
      async () =>
        new Response(redirectBody.body, {
          status: 302,
          headers: { location: "https://cdn.example/signed?token=secret" },
        }),
    );
    const onRedirect = vi.fn();

    await expect(
      fetchWithAppNetworkTransport({
        url: "https://public.example/start",
        fetchImpl,
        maxRedirects: 0,
        onRedirect,
      }),
    ).rejects.toThrow("Too many redirects (limit: 0)");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onRedirect).toHaveBeenCalledTimes(1);
    expect(onRedirect.mock.calls[0]?.[0].toString()).toBe(
      "https://cdn.example/signed?token=secret",
    );
    expect(redirectBody.cancel).toHaveBeenCalledTimes(1);
  });

  it("preserves direct allowed URLs and allowed-to-allowed redirects", async () => {
    const validateUrl = vi.fn((url: URL) => {
      if (url.hostname !== "allowed.example") {
        throw new Error(`blocked by test allowlist: ${url.hostname}`);
      }
    });
    const directFetch = vi.fn(async () => new Response("direct ok", { status: 200 }));

    const direct = await fetchWithAppNetworkTransport({
      url: "https://allowed.example/direct",
      fetchImpl: directFetch,
      validateUrl,
    });
    try {
      expect(direct.finalUrl).toBe("https://allowed.example/direct");
      await expect(readTestResponseText(direct.response)).resolves.toBe("direct ok");
    } finally {
      await direct.release();
    }

    const redirectFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://allowed.example/final" },
        }),
      )
      .mockResolvedValueOnce(new Response("redirect ok", { status: 200 }));

    const redirected = await fetchWithAppNetworkTransport({
      url: "https://allowed.example/start",
      fetchImpl: redirectFetch,
      maxRedirects: 2,
      validateUrl,
    });
    try {
      expect(redirected.finalUrl).toBe("https://allowed.example/final");
      await expect(readTestResponseText(redirected.response)).resolves.toBe("redirect ok");
      expect(redirectFetch.mock.calls.map((call) => call[0])).toEqual([
        "https://allowed.example/start",
        "https://allowed.example/final",
      ]);
    } finally {
      await redirected.release();
    }
  });

  it("propagates caller aborts to fetch and cleans up", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const pending = fetchWithAppNetworkTransport({
      url: "https://example.com/slow",
      fetchImpl,
      signal: controller.signal,
    });

    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow();
  });

  it("aborts requests when the timeout expires", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );

    const pending = fetchWithAppNetworkTransport({
      url: "https://example.com/slow",
      fetchImpl,
      timeoutMs: 20,
    });
    const rejection = expect(pending).rejects.toThrow("request timed out");

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
  });

  it("passes dispatcher-aware init for mocked fetches and skips it while managed proxy is active", async () => {
    const fetchImpl = vi.fn<NonNullable<AppFetchTransportOptions["fetchImpl"]>>(
      async () => new Response("ok", { status: 200 }),
    );
    const policy = { mode: "direct" as const };

    const direct = await fetchWithAppNetworkTransport({
      url: "https://example.com/file",
      fetchImpl,
      dispatcherPolicy: policy,
    });
    await direct.release();

    expect(
      (fetchImpl.mock.calls[0]?.[1] as { dispatcher?: unknown } | undefined)?.dispatcher,
    ).toBeDefined();

    fetchImpl.mockClear();
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");

    const proxied = await fetchWithAppNetworkTransport({
      url: "https://example.com/file",
      fetchImpl,
      dispatcherPolicy: policy,
    });
    await proxied.release();

    expect(
      (fetchImpl.mock.calls[0]?.[1] as { dispatcher?: unknown } | undefined)?.dispatcher,
    ).toBeUndefined();
  });
});
