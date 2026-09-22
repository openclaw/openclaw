import { once } from "node:events";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";
import { MARKER, startQuotaProvider } from "./quota-reset.test-support.js";

it.each(["http", "websocket"] as const)(
  "keeps the catalog held through auxiliary %s success until the primary reply",
  async (transport) => {
    const provider = await startQuotaProvider("codex_rate_limits", MARKER);
    const hold = provider.holdNextCatalog();
    const catalog = fetch(`${provider.baseUrl}/catalog/models`).then((response) => response.json());
    const request = async (model: string, path = "/v1/responses") => {
      const body = JSON.stringify({ type: "response.create", model, input: [] });
      if (transport === "http") {
        const response = await fetch(`${provider.baseUrl}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('"type":"response.completed"');
        return;
      }
      const socket = new WebSocket(`${provider.baseUrl.replace("http:", "ws:")}${path}`);
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once("error", reject);
          socket.on("message", (raw) => {
            const event: unknown = JSON.parse(rawDataToString(raw));
            if (
              event &&
              typeof event === "object" &&
              "type" in event &&
              event.type === "response.completed"
            ) {
              resolve();
            }
          });
          socket.once("open", () => socket.send(body));
        });
      } finally {
        if (socket.readyState !== WebSocket.CLOSED) {
          const closed = once(socket, "close");
          socket.terminate();
          await closed;
        }
      }
    };
    try {
      const captured = await hold.arrived;
      provider.setPhase("restored");
      const observed = vi.fn(() => hold.release());
      provider.observeNextSuccess(observed, { model: "gpt-5.5", path: "/v1/responses" });

      await request("gpt-5.6-luna");
      expect(observed).not.toHaveBeenCalled();
      expect(captured.releasedAt).toBeUndefined();
      await request("gpt-5.5", "/quota-backup/responses");
      expect(observed).not.toHaveBeenCalled();
      expect(captured.releasedAt).toBeUndefined();

      await request("gpt-5.5", "/v1/responses?fixture=primary");
      expect(observed).toHaveBeenCalledTimes(1);
      await catalog;
      expect(captured.releaseReason).toBe("explicit");
      await request("gpt-5.5");
      expect(observed).toHaveBeenCalledTimes(1);
      expect(provider.errors).toEqual([]);
    } finally {
      hold.release();
      try {
        await catalog;
      } finally {
        await provider.stop();
      }
    }
  },
);
