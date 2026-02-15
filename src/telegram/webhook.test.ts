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
const webhookCallbackSpy = vi.fn(() => handlerSpy);

const createTelegramBotSpy = vi.fn(() => ({
  api: { setWebhook: setWebhookSpy },
  stop: stopSpy,
}));

vi.mock("grammy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("grammy")>();
  return {
    ...actual,
    webhookCallback: (...args: unknown[]) => webhookCallbackSpy(...args),
  };
});

vi.mock("./bot.js", () => ({
  createTelegramBot: (...args: unknown[]) => createTelegramBotSpy(...args),
}));

describe("startTelegramWebhook", () => {
  it("starts server, registers webhook, and serves health", async () => {
    createTelegramBotSpy.mockClear();
    webhookCallbackSpy.mockClear();
    const abort = new AbortController();
    const cfg = { bindings: [] };
    const { server } = await startTelegramWebhook({
      token: "tok",
      secret: "secret",
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
    expect(webhookCallbackSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        api: expect.objectContaining({
          setWebhook: expect.any(Function),
        }),
      }),
      "http",
      {
        secretToken: "secret",
        onTimeout: "return",
        timeoutMilliseconds: 10_000,
      },
    );

    abort.abort();
  });

  it("invokes webhook handler on matching path", async () => {
    handlerSpy.mockClear();
    createTelegramBotSpy.mockClear();
    const abort = new AbortController();
    const cfg = { bindings: [] };
    const { server } = await startTelegramWebhook({
      token: "tok",
      secret: "secret",
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

  it("rejects startup when webhook secret is missing", async () => {
    await expect(
      startTelegramWebhook({
        token: "tok",
      }),
    ).rejects.toThrow(/requires a non-empty secret token/i);
  });
});
