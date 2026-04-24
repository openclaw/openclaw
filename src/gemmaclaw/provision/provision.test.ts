import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntimeManager, verifyCompletion } from "./provision.js";
import type { BackendId } from "./types.js";
import { ALL_BACKENDS } from "./types.js";

describe("createRuntimeManager", () => {
  it("creates a manager for each known backend", () => {
    for (const backend of ALL_BACKENDS) {
      const manager = createRuntimeManager(backend);
      expect(manager.id).toBe(backend);
      expect(typeof manager.displayName).toBe("string");
      expect(typeof manager.defaultPort).toBe("number");
    }
  });

  it("throws for unknown backend", () => {
    expect(() => createRuntimeManager("unknown" as BackendId)).toThrow(/Unknown backend/);
  });
});

describe("verifyCompletion", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          const parsed = JSON.parse(body) as { model?: string };
          if (parsed.model === "fail") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                choices: [{ message: { content: "" } }],
              }),
            );
            return;
          }
          if (parsed.model === "error") {
            res.writeHead(500);
            res.end("Internal error");
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: { role: "assistant", content: "Hello!" },
                  finish_reason: "stop",
                },
              ],
            }),
          );
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

  it("returns ok for non-empty response", async () => {
    const result = await verifyCompletion(`http://127.0.0.1:${port}`, "test-model");
    expect(result.ok).toBe(true);
    expect(result.content).toBe("Hello!");
  });

  it("returns not-ok for empty response", async () => {
    const result = await verifyCompletion(`http://127.0.0.1:${port}`, "fail");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Empty response");
  });

  it("returns not-ok for HTTP error", async () => {
    const result = await verifyCompletion(`http://127.0.0.1:${port}`, "error");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("500");
  });

  it("returns not-ok when server is unreachable", async () => {
    const result = await verifyCompletion("http://127.0.0.1:19995", "test");
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});
