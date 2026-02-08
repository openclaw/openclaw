import { describe, expect, it, vi } from "vitest";
import { startTelegramWebhook } from "./webhook.js";

const setWebhookSpy = vi.fn();
const stopSpy = vi.fn();
const initSpy = vi.fn(async () => undefined);
const handleUpdateSpy = vi.fn(async () => undefined);

const createTelegramBotSpy = vi.fn(() => ({
  api: { setWebhook: setWebhookSpy },
  stop: stopSpy,
  init: initSpy,
  handleUpdate: handleUpdateSpy,
}));

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

  it("ACKs quickly and processes update asynchronously", async () => {
    handleUpdateSpy.mockClear();
    initSpy.mockClear();
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

    expect(initSpy).toHaveBeenCalled();

    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("no addr");
    }

    const resp = await fetch(`http://127.0.0.1:${addr.port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update_id: 1, message: { message_id: 1, text: "hi" } }),
    });

    expect(resp.status).toBe(200);

    // Allow background handler to run.
    await new Promise((r) => setTimeout(r, 10));
    expect(handleUpdateSpy).toHaveBeenCalled();

    abort.abort();
  });
});
