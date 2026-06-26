// sessions_history tool tests cover recall redaction and input validation for
// session transcript history returned to models.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { callGateway as gatewayCall } from "../../gateway/call.js";
import { deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";

type CallGatewayRequest = Parameters<typeof gatewayCall>[0];

let createSessionsHistoryTool: typeof import("./sessions-history-tool.js").createSessionsHistoryTool;
let previousConfigPath: string | undefined;
let tempDir: string | undefined;

function useLoggingConfig(name: string, logging: Record<string, unknown>): void {
  if (!tempDir) {
    throw new Error("tempDir not initialized");
  }
  const configPath = path.join(tempDir, name);
  fs.writeFileSync(configPath, `${JSON.stringify({ logging })}\n`, "utf8");
  setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
}

function createHistoryToolWithMessage(content: string) {
  return createSessionsHistoryTool({
    config: {},
    callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "user",
              content,
            },
          ],
        } as T;
      }
      return {} as T;
    },
  });
}

describe("sessions_history redaction", () => {
  beforeAll(async () => {
    previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-history-redact-"));
    useLoggingConfig("redaction-off.json", { redactSensitive: "off" });
    ({ createSessionsHistoryTool } = await import("./sessions-history-tool.js"));
  });

  afterAll(() => {
    if (previousConfigPath === undefined) {
      deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
    } else {
      setTestEnvValue("OPENCLAW_CONFIG_PATH", previousConfigPath);
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("redacts recalled session text even when log redaction is disabled", async () => {
    // Recalled transcript content is model-visible, so it is always redacted
    // even when normal logging redaction is configured off.
    useLoggingConfig("redaction-off.json", { redactSensitive: "off" });
    const tool = createHistoryToolWithMessage("OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789");

    const result = await tool.execute("call-1", { sessionKey: "main" });
    const serialized = JSON.stringify(result.details);

    expect(serialized).not.toContain("sk-or-v1-abcdef0123456789");
    expect(serialized).toContain("OPENROUTER_API_KEY=");
    expect((result.details as { contentRedacted?: unknown }).contentRedacted).toBe(true);
  });

  it("applies custom redaction patterns to recalled session text", async () => {
    useLoggingConfig("custom-patterns.json", {
      redactSensitive: "off",
      redactPatterns: [String.raw`\binternal-ticket-[A-Za-z0-9]+\b`],
    });
    const tool = createHistoryToolWithMessage("follow up on internal-ticket-AbC12345");

    const result = await tool.execute("call-1", { sessionKey: "main" });
    const serialized = JSON.stringify(result.details);

    expect(serialized).not.toContain("internal-ticket-AbC12345");
    expect(serialized).toContain("intern");
    expect((result.details as { contentRedacted?: unknown }).contentRedacted).toBe(true);
  });

  it.each([0, 1.5])("rejects invalid limit value %s", async (limit) => {
    const tool = createHistoryToolWithMessage("hello");

    await expect(tool.execute("call-1", { sessionKey: "main", limit })).rejects.toThrow(
      "limit must be a positive integer",
    );
  });

  it.each([-1, 1.5])("rejects invalid offset value %s", async (offset) => {
    const tool = createHistoryToolWithMessage("hello");

    await expect(tool.execute("call-1", { sessionKey: "main", offset })).rejects.toThrow(
      "offset must be a non-negative integer",
    );
  });

  it("preserves the bounded default history request", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createSessionsHistoryTool({
      config: {},
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
        requests.push(request);
        return { messages: [{ role: "assistant", content: "latest" }] } as T;
      },
    });

    const result = await tool.execute("call-1", { sessionKey: "main", limit: 2 });

    expect(requests[0]).toMatchObject({
      method: "chat.history",
      params: { sessionKey: "main", limit: 2 },
    });
    expect((requests[0].params as Record<string, unknown>).offset).toBeUndefined();
    expect((result.details as Record<string, unknown>).offset).toBeUndefined();
  });

  it("requests explicit offset pages and returns continuation metadata", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createSessionsHistoryTool({
      config: {},
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
        requests.push(request);
        return {
          messages: [
            { role: "user", content: "newer" },
            { role: "assistant", content: "latest" },
          ],
          offset: 0,
          nextOffset: 2,
          hasMore: true,
          totalMessages: 4,
        } as T;
      },
    });

    const result = await tool.execute("call-1", { sessionKey: "main", limit: 2, offset: 0 });

    expect(requests[0]).toMatchObject({
      method: "chat.history",
      params: { sessionKey: "main", limit: 2, offset: 0 },
    });
    expect(result.details).toMatchObject({
      offset: 0,
      nextOffset: 2,
      hasMore: true,
      totalMessages: 4,
    });
  });
});
