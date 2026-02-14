import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteBridgeAuthForPort, setBridgeAuthForPort } from "./bridge-auth-registry.js";

describe("fetchBrowserJson loopback auth (bridge auth registry)", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("falls back to per-port bridge auth when config auth is not available", async () => {
    vi.doMock("../config/config.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../config/config.js")>();
      return {
        ...original,
        loadConfig: () => ({}),
      };
    });

    const server = createServer((req, res) => {
      const auth = String(req.headers.authorization ?? "").trim();
      if (auth !== "Bearer registry-token") {
        res.statusCode = 401;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Unauthorized");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const port = (server.address() as AddressInfo).port;
    setBridgeAuthForPort(port, { token: "registry-token" });

    try {
      const { fetchBrowserJson } = await import("./client-fetch.js");
      const result = await fetchBrowserJson<{ ok: boolean }>(`http://127.0.0.1:${port}/`, {
        timeoutMs: 2000,
      });
      expect(result.ok).toBe(true);
    } finally {
      deleteBridgeAuthForPort(port);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
