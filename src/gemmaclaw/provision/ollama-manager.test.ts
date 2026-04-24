import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOllamaManager } from "./ollama-manager.js";

// These tests validate the Ollama manager's logic without actually downloading
// or starting Ollama. The E2E test (test/e2e/) covers real provisioning.

describe("createOllamaManager", () => {
  const manager = createOllamaManager();

  it("has correct id and display name", () => {
    expect(manager.id).toBe("ollama");
    expect(manager.displayName).toBe("Ollama");
    expect(manager.defaultPort).toBe(11434);
  });

  describe("healthcheck", () => {
    let server: http.Server;
    let port: number;

    beforeAll(async () => {
      server = http.createServer((_, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Ollama is running");
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

    it("returns true when server responds OK", async () => {
      expect(await manager.healthcheck(port)).toBe(true);
    });

    it("returns false when nothing is listening", async () => {
      expect(await manager.healthcheck(19998)).toBe(false);
    });
  });

  describe("pullModel", () => {
    let server: http.Server;
    let port: number;
    let lastPulledModel: string | undefined;

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        if (req.method === "POST" && req.url === "/api/pull") {
          let body = "";
          req.on("data", (chunk: Buffer) => {
            body += chunk.toString();
          });
          req.on("end", () => {
            const parsed = JSON.parse(body) as { name: string };
            lastPulledModel = parsed.name;
            // Simulate a streaming pull response.
            res.writeHead(200, { "Content-Type": "application/x-ndjson" });
            res.write(JSON.stringify({ status: "pulling manifest" }) + "\n");
            res.write(JSON.stringify({ status: "downloading", total: 100, completed: 100 }) + "\n");
            res.write(JSON.stringify({ status: "success" }) + "\n");
            res.end();
          });
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

    it("sends pull request to Ollama API", async () => {
      const messages: string[] = [];
      await manager.pullModel("gemma3:1b", port, (msg) => messages.push(msg));

      expect(lastPulledModel).toBe("gemma3:1b");
      expect(messages.some((m) => m.includes("gemma3:1b"))).toBe(true);
    });

    it("uses default model when empty string provided", async () => {
      await manager.pullModel("", port);
      expect(lastPulledModel).toBe("gemma3:1b");
    });

    it("throws on pull error", async () => {
      // Create a server that returns an error in the stream.
      const errorServer = http.createServer((req, res) => {
        if (req.method === "POST" && req.url === "/api/pull") {
          let body = "";
          req.on("data", (chunk: Buffer) => {
            body += chunk.toString();
          });
          req.on("end", () => {
            res.writeHead(200, { "Content-Type": "application/x-ndjson" });
            res.write(JSON.stringify({ error: "model not found" }) + "\n");
            res.end();
          });
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => {
        errorServer.listen(0, "127.0.0.1", resolve);
      });
      const errorAddr = errorServer.address();
      const errorPort = typeof errorAddr === "object" && errorAddr ? errorAddr.port : 0;

      try {
        await expect(manager.pullModel("bad-model", errorPort)).rejects.toThrow(/Pull failed/);
      } finally {
        await new Promise<void>((resolve) => {
          errorServer.close(() => resolve());
        });
      }
    });
  });
});
