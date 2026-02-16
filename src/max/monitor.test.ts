import { beforeEach, describe, expect, it, vi } from "vitest";
import { monitorMaxProvider } from "./monitor.js";

// Mock the @maxhub/max-bot-api Bot class
const botStartMock = vi.fn();
const botStopMock = vi.fn();
const botUseMock = vi.fn();

vi.mock("@maxhub/max-bot-api", () => ({
  Bot: class MockBot {
    constructor(public token: string) {}
    use = botUseMock;
    start = botStartMock;
    stop = botStopMock;
  },
}));

// Mock fetchWithTimeout for webhook tests
const fetchWithTimeoutMock = vi.fn();
vi.mock("../utils/fetch-timeout.js", () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchWithTimeoutMock(...args),
}));

// Suppress proxy import
vi.mock("../telegram/proxy.js", () => ({
  makeProxyFetch: vi.fn(() => vi.fn()),
}));

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

describe("monitorMaxProvider — long polling", () => {
  beforeEach(() => {
    botStartMock.mockReset();
    botStopMock.mockReset();
    botUseMock.mockReset();
    fetchWithTimeoutMock.mockReset();
  });

  it("uses long polling by default (no webhookUrl)", async () => {
    const abortController = new AbortController();

    // Bot.start resolves, then on next loop iteration abort is already set
    botStartMock.mockImplementation(() => {
      // Abort after first successful start so the loop exits
      abortController.abort();
      return Promise.resolve();
    });

    await monitorMaxProvider({
      token: "test-token",
      accountId: "default",
      abortSignal: abortController.signal,
    });

    expect(botUseMock).toHaveBeenCalledTimes(1);
    expect(botStartMock).toHaveBeenCalledTimes(1);

    // Verify allowed update types
    const startOpts = botStartMock.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(startOpts?.allowedUpdates).toEqual(
      expect.arrayContaining(["message_created", "message_callback", "bot_started"]),
    );
  });

  it("stops bot when abort signal fires during polling", async () => {
    const abortController = new AbortController();

    // Bot.start blocks forever until stopped
    botStartMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          botStopMock.mockImplementation(() => resolve());
        }),
    );

    const monitorPromise = monitorMaxProvider({
      token: "test-token",
      abortSignal: abortController.signal,
    });

    // Give time for the bot to start
    await new Promise((r) => setTimeout(r, 20));

    abortController.abort();

    await monitorPromise;

    expect(botStopMock).toHaveBeenCalled();
  });

  it("retries with backoff on polling error", async () => {
    const abortController = new AbortController();

    let startCallCount = 0;
    botStartMock.mockImplementation(() => {
      startCallCount++;
      if (startCallCount === 1) {
        return Promise.reject(new Error("Connection reset"));
      }
      // Second call: resolve and abort
      abortController.abort();
      return Promise.resolve();
    });

    const runtimeLog = vi.fn();
    await monitorMaxProvider({
      token: "test-token",
      accountId: "test",
      abortSignal: abortController.signal,
      runtime: {
        log: runtimeLog,
        error: console.error,
        exit: () => {
          throw new Error("exit");
        },
      },
    });

    expect(startCallCount).toBe(2);
    // Should have logged the retry
    expect(runtimeLog).toHaveBeenCalledWith(expect.stringContaining("polling error"));
  });
});

describe("monitorMaxProvider — webhook", () => {
  beforeEach(() => {
    fetchWithTimeoutMock.mockReset();
  });

  it("subscribes webhook then waits for abort, then unsubscribes", async () => {
    const abortController = new AbortController();

    // Subscribe response
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    // Unsubscribe response
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ success: true }));

    const monitorPromise = monitorMaxProvider({
      token: "webhook-token",
      accountId: "webhook-acc",
      useWebhook: true,
      webhookUrl: "https://example.com/max/webhook",
      webhookSecret: "secret123",
      abortSignal: abortController.signal,
    });

    // Wait for subscription
    await new Promise((r) => setTimeout(r, 50));

    // Verify subscribe call
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    const [subUrl, subInit] = fetchWithTimeoutMock.mock.calls[0] as [string, RequestInit];
    expect(subUrl).toBe("https://platform-api.max.ru/subscriptions");
    expect(subInit.method).toBe("POST");

    const subBody = JSON.parse(subInit.body as string) as Record<string, unknown>;
    expect(subBody.url).toBe("https://example.com/max/webhook");
    expect(subBody.secret).toBe("secret123");
    expect(subBody.update_types).toEqual(
      expect.arrayContaining(["message_created", "message_callback"]),
    );

    const subHeaders = subInit.headers as Record<string, string>;
    expect(subHeaders.Authorization).toBe("webhook-token");

    // Abort to trigger unsubscribe
    abortController.abort();
    await monitorPromise;

    // Should have called DELETE /subscriptions
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
    const [delUrl, delInit] = fetchWithTimeoutMock.mock.calls[1] as [string, RequestInit];
    expect(delUrl).toBe("https://platform-api.max.ru/subscriptions");
    expect(delInit.method).toBe("DELETE");
  });

  it("throws if webhook subscription fails", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ error: "Invalid URL" }, 400));

    await expect(
      monitorMaxProvider({
        token: "tok",
        useWebhook: true,
        webhookUrl: "https://bad-url.example.com/webhook",
      }),
    ).rejects.toThrow(/MAX webhook subscription failed \(400\)/);
  });

  it("handles unsubscribe failure gracefully (best-effort cleanup)", async () => {
    const abortController = new AbortController();

    // Subscribe success
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    // Unsubscribe fails
    fetchWithTimeoutMock.mockRejectedValueOnce(new Error("Network error"));

    const monitorPromise = monitorMaxProvider({
      token: "tok",
      useWebhook: true,
      webhookUrl: "https://example.com/webhook",
      abortSignal: abortController.signal,
    });

    await new Promise((r) => setTimeout(r, 50));
    abortController.abort();

    // Should not throw even though unsubscribe failed
    await expect(monitorPromise).resolves.toBeUndefined();
  });

  it("omits secret from subscribe body when webhookSecret is not set", async () => {
    const abortController = new AbortController();

    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ success: true }));

    const monitorPromise = monitorMaxProvider({
      token: "tok",
      useWebhook: true,
      webhookUrl: "https://example.com/webhook",
      abortSignal: abortController.signal,
    });

    await new Promise((r) => setTimeout(r, 50));

    const subBody = JSON.parse(
      (fetchWithTimeoutMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect(subBody.secret).toBeUndefined();

    abortController.abort();
    await monitorPromise;
  });
});
