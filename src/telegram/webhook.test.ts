import { describe, expect, it, vi } from "vitest";

import { startTelegramWebhook } from "./webhook.js";

const handlerSpy = vi.fn((req: any, res: any) => {
  res.writeHead(200);
  res.end("ok");
});
const setWebhookSpy = vi.fn();
const stopSpy = vi.fn();

vi.mock("grammy", () => ({
  webhookCallback: () => handlerSpy,
}));

vi.mock("./bot.js", () => ({
  createTelegramBot: () => ({
    api: { setWebhook: setWebhookSpy },
    stop: stopSpy,
  }),
}));

describe("startTelegramWebhook", () => {
  it("starts server, registers webhook, and serves health", async () => {
    const abort = new AbortController();
    const { server } = await startTelegramWebhook({
      token: "tok",
      port: 0, // random free port
      abortSignal: abort.signal,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const url = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${url}/healthz`);
    expect(health.status).toBe(200);
    expect(setWebhookSpy).toHaveBeenCalled();

    abort.abort();
  });

  it("invokes webhook handler on matching path", async () => {
    handlerSpy.mockClear();
    const abort = new AbortController();
    const { server } = await startTelegramWebhook({
      token: "tok",
      port: 0,
      abortSignal: abort.signal,
      path: "/hook",
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    await fetch(`http://127.0.0.1:${addr.port}/hook`, { method: "POST" });
    expect(handlerSpy).toHaveBeenCalled();
    abort.abort();
  });
});
