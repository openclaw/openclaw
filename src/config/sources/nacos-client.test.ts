import { describe, it, expect, vi, beforeEach } from "vitest";
import { createNacosConfigClient } from "./nacos-client.js";

describe("createNacosConfigClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetchConfig returns content from Nacos server", async () => {
    const client = createNacosConfigClient({
      serverAddr: "http://127.0.0.1:8848",
      dataId: "openclaw.json",
      group: "DEFAULT_GROUP",
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('{"a":1}'),
      }),
    });
    const content = await client.fetchConfig();
    expect(content).toBe('{"a":1}');
  });

  it("fetchConfig includes tenant in URL when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("{}"),
    });
    const client = createNacosConfigClient({
      serverAddr: "http://127.0.0.1:8848",
      dataId: "openclaw.json",
      group: "DEFAULT_GROUP",
      tenant: "ns-1",
      fetch: fetchMock,
    });
    await client.fetchConfig();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8848/nacos/v1/cs/configs?dataId=openclaw.json&group=DEFAULT_GROUP&tenant=ns-1",
    );
  });

  it("subscribe returns teardown and invokes callback when listener reports change", async () => {
    let listenerResolve!: (value: { ok: boolean; text: () => Promise<string> }) => void;
    const listenerPromise = new Promise<{ ok: boolean; text: () => Promise<string> }>((r) => {
      listenerResolve = r;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve("{}"),
      })
      .mockImplementationOnce(() => listenerPromise.then((res) => res))
      .mockResolvedValue({ ok: true, text: () => Promise.resolve("") });
    const client = createNacosConfigClient({
      serverAddr: "http://127.0.0.1:8848",
      dataId: "openclaw.json",
      group: "DEFAULT_GROUP",
      fetch: fetchMock,
    });
    const onChange = vi.fn();
    const teardown = client.subscribe(onChange);
    expect(typeof teardown).toBe("function");
    // Simulate Nacos long-poll return
    listenerResolve({ ok: true, text: () => Promise.resolve("openclaw.json") });
    await new Promise((r) => setTimeout(r, 10));
    expect(onChange).toHaveBeenCalled();
    teardown();
  });

  it("subscribe backs off when listener returns HTTP error", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: () => Promise.resolve(""),
    });

    const client = createNacosConfigClient({
      serverAddr: "http://127.0.0.1:8848",
      dataId: "openclaw.json",
      group: "DEFAULT_GROUP",
      fetch: fetchMock,
    });

    const onChange = vi.fn();
    const teardown = client.subscribe(onChange);

    // Flush the initial microtasks so poll() reaches the HTTP error branch.
    await Promise.resolve();

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
    teardown();

    // Let the scheduled backoff settle and avoid leaving pending timers/promises.
    await vi.advanceTimersByTimeAsync(5000);

    expect(onChange).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });
});
