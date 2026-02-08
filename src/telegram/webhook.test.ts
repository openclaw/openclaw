import { describe, expect, it, vi } from "vitest";
import { startTelegramWebhook } from "./webhook.js";

const handlerSpy = vi.fn(
  (_req: unknown, res: { writeHead: (status: number) => void; end: (body?: string) => void }) => {
    res.writeHead(200);
    res.end("ok");
  },
);
const setWebhookSpy = vi.fn();
const stopSpy = vi.fn();

const createTelegramBotSpy = vi.fn(() => ({
  api: { setWebhook: setWebhookSpy },
  stop: stopSpy,
}));

vi.mock("grammy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("grammy")>();
  return { ...actual, webhookCallback: () => handlerSpy };
});

vi.mock("./bot.js", () => ({
  createTelegramBot: (...args: unknown[]) => createTelegramBotSpy(...args),
}));

describe("startTelegramWebhook", () => {
  it("starts server, registers webhook, and serves health", async () => {
    createTelegramBotSpy.mockClear();
    const abort = new AbortController();
    const cfg = { bindings: [] };
    const { server } = await startTelegramWebhook({
      token: "tok",
      accountId: "opie",
      config: cfg,
      port: 0, // random free port
      abortSignal: abort.signal,
    });
    expect(createTelegramBotSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "opie",
        config: expect.objectContaining({ bindings: [] }),
      }),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("no address");
    }
    const url = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${url}/healthz`);
    expect(health.status).toBe(200);
    expect(setWebhookSpy).toHaveBeenCalled();

    abort.abort();
  });

  it("invokes webhook handler on matching path", async () => {
    handlerSpy.mockClear();
    createTelegramBotSpy.mockClear();
    const abort = new AbortController();
    const cfg = { bindings: [] };
    const { server } = await startTelegramWebhook({
      token: "tok",
      accountId: "opie",
      config: cfg,
      port: 0,
      abortSignal: abort.signal,
      path: "/hook",
    });
    expect(createTelegramBotSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "opie",
        config: expect.objectContaining({ bindings: [] }),
      }),
    );
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("no addr");
    }
    await fetch(`http://127.0.0.1:${addr.port}/hook`, { method: "POST" });
    expect(handlerSpy).toHaveBeenCalled();
    abort.abort();
  });

  it("defaults to loopback host (127.0.0.1) when host is not specified", async () => {
    const abort = new AbortController();
    const cfg = { bindings: [] };
    const { server } = await startTelegramWebhook({
      token: "tok",
      accountId: "opie",
      config: cfg,
      port: 0,
      abortSignal: abort.signal,
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("no addr");
    }
    // Default host should be loopback, not 0.0.0.0
    expect(addr.address).toBe("127.0.0.1");
    abort.abort();
  });

  it("defaults to 0.0.0.0 when publicUrl is external", async () => {
    const abort = new AbortController();
    const cfg = { bindings: [] };
    const { server } = await startTelegramWebhook({
      token: "tok",
      accountId: "opie",
      config: cfg,
      port: 0,
      abortSignal: abort.signal,
      publicUrl: "https://my-server.example.com/telegram-webhook",
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("no addr");
    }
    // External publicUrl should bind to all interfaces
    expect(addr.address).toBe("0.0.0.0");
    abort.abort();
  });

  it("logs warning when no webhook secret is configured", async () => {
    const logSpy = vi.fn();
    const abort = new AbortController();
    const cfg = { bindings: [] };
    await startTelegramWebhook({
      token: "tok",
      accountId: "opie",
      config: cfg,
      port: 0,
      abortSignal: abort.signal,
      runtime: { log: logSpy },
    });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("webhook secret token is not configured"),
    );
    abort.abort();
  });

  it("does not log warning when webhook secret is provided", async () => {
    const logSpy = vi.fn();
    const abort = new AbortController();
    const cfg = { bindings: [] };
    await startTelegramWebhook({
      token: "tok",
      accountId: "opie",
      config: cfg,
      port: 0,
      abortSignal: abort.signal,
      secret: "my-secret-token",
      runtime: { log: logSpy },
    });
    const secretWarnings = logSpy.mock.calls.filter(
      ([msg]: [string]) =>
        typeof msg === "string" && msg.includes("secret token is not configured"),
    );
    expect(secretWarnings).toHaveLength(0);
    abort.abort();
  });
});
