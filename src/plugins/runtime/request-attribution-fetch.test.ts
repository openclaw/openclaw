import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  installPluginRuntimeRequestAttributionFetch,
  resetPluginRuntimeRequestAttributionFetchForTests,
} from "./request-attribution-fetch.js";
import { withPluginRuntimeRequestAttributionScope } from "./request-attribution-scope.js";

afterEach(() => {
  resetPluginRuntimeRequestAttributionFetchForTests();
  delete process.env.VIDA_API_BASE_URL;
});

describe("request attribution fetch wrapper", () => {
  it("injects agent/session headers only for VIDA openai relay requests", async () => {
    const seen: Array<{ url?: string; agent?: string | null; session?: string | null }> = [];
    const server = http.createServer((req, res) => {
      seen.push({
        url: req.url,
        agent: req.headers["x-openclaw-agent-id"]?.toString() ?? null,
        session: req.headers["x-openclaw-session-key"]?.toString() ?? null,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    process.env.VIDA_API_BASE_URL = `http://127.0.0.1:${port}`;
    installPluginRuntimeRequestAttributionFetch();

    try {
      await withPluginRuntimeRequestAttributionScope(
        {
          agentId: "agent-alpha",
          sessionKey: "agent:agent-alpha:web:conv-1",
        },
        async () => {
          await fetch(`${process.env.VIDA_API_BASE_URL}/openai/v1/embeddings`, { method: "POST" });
          await fetch(`${process.env.VIDA_API_BASE_URL}/api/v2/health`, { method: "POST" });
        },
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }

    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({
      url: "/openai/v1/embeddings",
      agent: "agent-alpha",
      session: "agent:agent-alpha:web:conv-1",
    });
    expect(seen[1]).toEqual({
      url: "/api/v2/health",
      agent: null,
      session: null,
    });
  });
});
