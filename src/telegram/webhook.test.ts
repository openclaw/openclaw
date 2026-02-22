import { describe, expect, it, vi } from "vitest";
import { startTelegramWebhook } from "./webhook.js";

const handlerSpy = vi.hoisted(() =>
  vi.fn(
    (_req: unknown, res: { writeHead: (status: number) => void; end: (body?: string) => void }) => {
      res.writeHead(200);
      res.end("ok");
    },
  ),
);
const setWebhookSpy = vi.hoisted(() => vi.fn());
const stopSpy = vi.hoisted(() => vi.fn());
const webhookCallbackSpy = vi.hoisted(() => vi.fn(() => handlerSpy));
const createTelegramBotSpy = vi.hoisted(() =>
  vi.fn(() => ({
    api: { setWebhook: setWebhookSpy },
    stop: stopSpy,
  })),
);

vi.mock("grammy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("grammy")>();
  return {
    ...actual,
    webhookCallback: webhookCallbackSpy,
  };
});

vi.mock("./bot.js", () => ({
  createTelegramBot: createTelegramBotSpy,
}));

describe("startTelegramWebhook", () => {
  it("starts server, registers webhook, and serves health", async () => {
    createTelegramBotSpy.mockClear();
    webhookCallbackSpy.mockClear();
    setWebhookSpy.mockClear();
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
    setWebhookSpy.mockClear();
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

  it("uses account-specific default path for non-default accounts", async () => {
    setWebhookSpy.mockClear();
    const abort = new AbortController();

    await startTelegramWebhook({
      token: "tok",
      secret: "secret",
      accountId: "work",
      port: 0,
      abortSignal: abort.signal,
    });

    const webhookUrl = String(setWebhookSpy.mock.calls[0]?.[0] ?? "");
    expect(webhookUrl).toContain("/telegram-webhook/work");
    abort.abort();
  });

  it("shares one listener for multiple accounts with distinct paths", async () => {
    handlerSpy.mockClear();
    setWebhookSpy.mockClear();
    const abortDefault = new AbortController();
    const abortWork = new AbortController();

    const first = await startTelegramWebhook({
      token: "tok-default",
      secret: "secret-default",
      accountId: "default",
      port: 0,
      abortSignal: abortDefault.signal,
    });
    const second = await startTelegramWebhook({
      token: "tok-work",
      secret: "secret-work",
      accountId: "work",
      port: 0,
      abortSignal: abortWork.signal,
    });

    expect(first.server).toBe(second.server);
    const addr = first.server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("no addr");
    }
    await fetch(`http://127.0.0.1:${addr.port}/telegram-webhook`, { method: "POST" });
    await fetch(`http://127.0.0.1:${addr.port}/telegram-webhook/work`, { method: "POST" });
    expect(handlerSpy).toHaveBeenCalledTimes(2);

    abortWork.abort();
    abortDefault.abort();
  });

  it("rejects path conflicts between accounts on the same listener", async () => {
    const abort = new AbortController();
    await startTelegramWebhook({
      token: "tok-default",
      secret: "secret-default",
      accountId: "default",
      path: "/same",
      port: 0,
      abortSignal: abort.signal,
    });

    await expect(
      startTelegramWebhook({
        token: "tok-work",
        secret: "secret-work",
        accountId: "work",
        path: "/same",
        port: 0,
      }),
    ).rejects.toThrow(/path conflict/i);

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
