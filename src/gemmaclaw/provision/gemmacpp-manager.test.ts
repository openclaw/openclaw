import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGemmaCppManager } from "./gemmacpp-manager.js";

describe("createGemmaCppManager", () => {
  const manager = createGemmaCppManager();

  it("has correct id and display name", () => {
    expect(manager.id).toBe("gemma-cpp");
    expect(manager.displayName).toBe("gemma.cpp");
    expect(manager.defaultPort).toBe(11436);
  });

  describe("healthcheck", () => {
    let server: http.Server;
    let port: number;

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        if (req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok" }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const addr = server.address();
      port = typeof addr === "object" && addr ? addr.port : 0;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });

    it("returns true when /health responds OK", async () => {
      expect(await manager.healthcheck(port)).toBe(true);
    });

    it("returns false when nothing is listening", async () => {
      expect(await manager.healthcheck(19996)).toBe(false);
    });
  });

  describe("pullModel", () => {
    it("throws when HF_TOKEN is not set", async () => {
      const origToken = process.env.HF_TOKEN;
      delete process.env.HF_TOKEN;

      try {
        await expect(manager.pullModel("gemma-2-2b-it", 11436)).rejects.toThrow(/HF_TOKEN/);
      } finally {
        if (origToken !== undefined) {
          process.env.HF_TOKEN = origToken;
        }
      }
    });
  });
});
