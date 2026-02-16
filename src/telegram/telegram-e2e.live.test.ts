import { expect, it } from "vitest";
import { describeLive } from "../test-utils/live-test-helpers.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
const CHAT_ID = process.env.OPENCLAW_LIVE_TELEGRAM_CHAT_ID?.trim() || "";
const API = `https://api.telegram.org/bot${TOKEN}`;

const runSuite = describeLive({
  name: "telegram (live): e2e bot connectivity and send",
  envVars: [
    { name: "TELEGRAM_BOT_TOKEN", value: process.env.TELEGRAM_BOT_TOKEN, required: true },
    {
      name: "OPENCLAW_LIVE_TELEGRAM_CHAT_ID",
      value: process.env.OPENCLAW_LIVE_TELEGRAM_CHAT_ID,
      required: true,
    },
  ],
});

runSuite("telegram (live): e2e bot connectivity and send", () => {
  it("bot token is valid — getMe succeeds", { timeout: 15_000 }, async () => {
    const res = await fetch(`${API}/getMe`);
    const json = (await res.json()) as { ok: boolean; result: { is_bot: boolean; username: string } };
    expect(json.ok).toBe(true);
    expect(json.result.is_bot).toBe(true);
    expect(json.result.username).toBeTruthy();
  });

  it("bot can send a message to the test chat", { timeout: 15_000 }, async () => {
    const marker = `[live-test] ${new Date().toISOString()}`;
    const res = await fetch(`${API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: marker }),
    });
    const json = (await res.json()) as {
      ok: boolean;
      result: { message_id: number; text: string };
    };
    expect(json.ok).toBe(true);
    expect(json.result.message_id).toBeGreaterThan(0);
    expect(json.result.text).toBe(marker);
  });
});
