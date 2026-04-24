import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLlamaCppManager } from "./llamacpp-manager.js";

describe("createLlamaCppManager", () => {
  const manager = createLlamaCppManager();

  it("has correct id and display name", () => {
    expect(manager.id).toBe("llama-cpp");
    expect(manager.displayName).toBe("llama.cpp");
    expect(manager.defaultPort).toBe(8080);
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
      expect(await manager.healthcheck(19997)).toBe(false);
    });
  });
});
