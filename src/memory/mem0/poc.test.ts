import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { __mem0TestHooks, captureLongTermMemory, recallAndBuildInjectText } from "./poc.js";

type TestServer = {
  baseUrl: string;
  close: () => Promise<void>;
  state: {
    healthChecks: number;
    storeCalls: number;
    memories: string[];
  };
};

async function createMem0TestServer(params?: {
  healthOk?: boolean;
  storeStatus?: number;
  recallResults?: Array<{ text: string; score?: number }>;
}): Promise<TestServer> {
  const state = {
    healthChecks: 0,
    storeCalls: 0,
    memories: [] as string[],
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      if (req.url === "/health") {
        state.healthChecks += 1;
        const ok = params?.healthOk ?? true;
        res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok }));
        return;
      }
      if (req.url === "/v1/memories" && req.method === "POST") {
        state.storeCalls += 1;
        const payload = JSON.parse(body || "{}") as { memory?: string };
        if (typeof payload.memory === "string") {
          state.memories.push(payload.memory);
        }
        const status = params?.storeStatus ?? 200;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: status >= 200 && status < 300 }));
        return;
      }
      if (req.url === "/v1/memories/search" && req.method === "POST") {
        const results =
          params?.recallResults ??
          state.memories.map((text, index) => ({
            text,
            score: 0.92 - index * 0.01,
          }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ results }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to resolve test server address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () =>
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
    state,
  };
}

function withMem0Env(vars: Record<string, string>) {
  process.env.MEM0_ENABLED = "true";
  process.env.MEM0_API_KEY = "test-key";
  process.env.MEM0_CAPTURE_ENABLED = "true";
  for (const [key, value] of Object.entries(vars)) {
    process.env[key] = value;
  }
}

afterEach(() => {
  __mem0TestHooks.resetState();
  delete process.env.MEM0_ENABLED;
  delete process.env.MEM0_BASE_URL;
  delete process.env.MEM0_API_KEY;
  delete process.env.MEM0_RECALL_LIMIT;
  delete process.env.MEM0_RECALL_THRESHOLD;
  delete process.env.MEM0_CAPTURE_ENABLED;
  delete process.env.MEM0_INJECT_MAX_ITEMS;
  delete process.env.MEM0_INJECT_ITEM_MAX_CHARS;
  delete process.env.MEM0_INJECT_MAX_CHARS;
  delete process.env.MEM0_INJECT_MAX_ESTIMATED_TOKENS;
  delete process.env.MEM0_STORE_DEDUPE_WINDOW_MS;
  delete process.env.MEM0_CIRCUIT_OPEN_MS;
});

describe("mem0 poc", () => {
  it("caps recall injection by item count, item chars, and total chars", async () => {
    const server = await createMem0TestServer({
      recallResults: [
        { text: "A".repeat(400), score: 0.95 },
        { text: "用户偏好中文交流", score: 0.93 },
        { text: "用户偏好结构化输出", score: 0.92 },
        { text: "项目优先本地可控", score: 0.91 },
      ],
    });
    try {
      withMem0Env({
        MEM0_BASE_URL: server.baseUrl,
        MEM0_RECALL_LIMIT: "5",
        MEM0_RECALL_THRESHOLD: "0.75",
        MEM0_INJECT_MAX_ITEMS: "2",
        MEM0_INJECT_ITEM_MAX_CHARS: "70",
        MEM0_INJECT_MAX_CHARS: "160",
        MEM0_INJECT_MAX_ESTIMATED_TOKENS: "40",
      });
      const result = await recallAndBuildInjectText({
        query: "偏好",
        userId: "u1",
        agentId: "main",
        runId: "r1",
      });
      expect(result?.injectedText).toBeDefined();
      const injected = result?.injectedText ?? "";
      const lines = injected
        .split("\n")
        .filter((line) => line.trim().startsWith("- "))
        .map((line) => line.replace(/^-\s*/, ""));
      expect(lines.length).toBeLessThanOrEqual(2);
      expect(lines.every((line) => line.length <= 70)).toBe(true);
      expect(injected.length).toBeLessThanOrEqual(160);
    } finally {
      await server.close();
    }
  });

  it("deduplicates store calls within dedupe window", async () => {
    const server = await createMem0TestServer();
    try {
      withMem0Env({
        MEM0_BASE_URL: server.baseUrl,
        MEM0_STORE_DEDUPE_WINDOW_MS: "1000",
      });
      await captureLongTermMemory({
        userMessage: "我喜欢结构化输出",
        assistantMessage: "收到，我会结构化回答。",
        userId: "u1",
        agentId: "main",
        runId: "d1",
      });
      await captureLongTermMemory({
        userMessage: "我喜欢结构化输出",
        assistantMessage: "收到，我会结构化回答。",
        userId: "u1",
        agentId: "main",
        runId: "d2",
      });
      expect(server.state.storeCalls).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await captureLongTermMemory({
        userMessage: "我喜欢结构化输出",
        assistantMessage: "收到，我会结构化回答。",
        userId: "u1",
        agentId: "main",
        runId: "d3",
      });
      expect(server.state.storeCalls).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("recovers from open circuit via half-open probe", async () => {
    withMem0Env({
      MEM0_BASE_URL: "http://127.0.0.1:65530",
      MEM0_CIRCUIT_OPEN_MS: "1000",
      MEM0_RECALL_LIMIT: "3",
      MEM0_RECALL_THRESHOLD: "0.75",
    });
    const first = await recallAndBuildInjectText({
      query: "first",
      userId: "u1",
      agentId: "main",
      runId: "r1",
    });
    expect(first).toBeUndefined();

    const server = await createMem0TestServer({
      recallResults: [{ text: "恢复后的记忆", score: 0.9 }],
    });
    try {
      process.env.MEM0_BASE_URL = server.baseUrl;
      const second = await recallAndBuildInjectText({
        query: "second",
        userId: "u1",
        agentId: "main",
        runId: "r2",
      });
      expect(second).toBeUndefined();

      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const third = await recallAndBuildInjectText({
        query: "third",
        userId: "u1",
        agentId: "main",
        runId: "r3",
      });
      expect(third).toBeDefined();
      expect(third?.injectedText).toBeDefined();
      expect(third?.injectedText ?? "").toContain("Relevant long-term memory");
      expect(server.state.healthChecks).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });
});
