import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import {
  type CallGatewayRequest,
  readHistoryDetails,
  readMessageId,
  requireGatewayRequest,
} from "./sessions-history-tool.test-support.js";

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

describe("sessions_history anchored byte budget", () => {
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

  it("serializes each message once while growing a 512-message anchored window", async () => {
    const messages = Array.from({ length: 512 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `入口 🦊 "message ${index}"\n`,
      __openclaw: { id: `budget-${index}`, seq: index + 1 },
    }));
    const ids = new Set(messages.map((message) => readMessageId(message)));
    const requests: CallGatewayRequest[] = [];
    const tool = createSessionsHistoryTool({
      config: {},
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
        requests.push(request);
        return { messages, totalMessages: messages.length } as T;
      },
    });
    const stringify = JSON.stringify;
    const originalMessages = stringify(messages);
    const descriptor = expectDefined(
      Object.getOwnPropertyDescriptor(JSON, "stringify"),
      "native JSON.stringify descriptor",
    );
    let serializedElements = 0;
    Object.defineProperty(JSON, "stringify", {
      ...descriptor,
      value(...args: Parameters<typeof JSON.stringify>) {
        const [value] = args;
        if (
          Array.isArray(value) &&
          value.length > 0 &&
          value.every((message) => ids.has(readMessageId(message) ?? ""))
        ) {
          serializedElements += value.length;
        }
        return stringify(...args);
      },
    });
    let result: Awaited<ReturnType<typeof tool.execute>>;
    try {
      result = await tool.execute("anchored-work-budget", {
        sessionKey: "main",
        limit: messages.length,
        messageId: "budget-256",
      });
    } finally {
      Object.defineProperty(JSON, "stringify", descriptor);
    }

    const expected = {
      sessionKey: "main",
      messages,
      truncated: false,
      droppedMessages: false,
      contentTruncated: false,
      contentRedacted: false,
      bytes: Buffer.byteLength(originalMessages),
      totalMessages: messages.length,
    };
    expect(result).toEqual({
      content: [{ type: "text", text: stringify(expected, null, 2) }],
      details: expected,
    });
    expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
    expect(requireGatewayRequest(requests, "chat.history")).toMatchObject({
      params: { sessionKey: "main", limit: 512, messageId: "budget-256" },
    });
    expect(stringify(messages)).toBe(originalMessages);
    expect(serializedElements).toBe(messages.length);
  });

  it.each([
    {
      name: "grows older first when only one neighbor fits",
      ids: ["older", "anchor", "newer"],
      large: ["older", "anchor", "newer"],
      blocks: 10,
      expectedIds: ["older", "anchor"],
    },
    {
      name: "continues newer after the older side is blocked",
      ids: ["blocked-older", "anchor", "newer"],
      large: ["blocked-older"],
      blocks: 21,
      expectedIds: ["anchor", "newer"],
    },
    {
      name: "continues older after the newer side is blocked",
      ids: ["oldest", "older", "anchor", "blocked-newer", "latest"],
      large: ["blocked-newer"],
      blocks: 21,
      expectedIds: ["oldest", "older", "anchor"],
    },
  ])("$name", async ({ ids, large, blocks, expectedIds }) => {
    const messages = ids.map((id, index) => ({
      role: "assistant",
      content: large.includes(id)
        ? Array.from({ length: blocks }, () => ({ type: "text", text: "x".repeat(4_000) }))
        : id,
      __openclaw: { id, seq: index + 1 },
    }));
    const tool = createSessionsHistoryTool({
      config: {},
      callGateway: async <T = Record<string, unknown>>(): Promise<T> =>
        ({ messages, totalMessages: messages.length }) as T,
    });
    const result = await tool.execute("anchored-neighbors", {
      sessionKey: "main",
      messageId: "anchor",
    });
    const expectedMessages = messages.filter((message) =>
      expectedIds.includes(readMessageId(message) ?? ""),
    );

    expect(result.details).toEqual({
      sessionKey: "main",
      messages: expectedMessages,
      truncated: true,
      droppedMessages: true,
      contentTruncated: false,
      contentRedacted: false,
      bytes: Buffer.byteLength(JSON.stringify(expectedMessages)),
      totalMessages: messages.length,
    });
  });

  it.each([0, 1])(
    "preserves the anchored byte boundary with pending inputs at excess %i",
    async (excess) => {
      const pendingInputs = {
        items: [
          {
            id: "queued",
            acceptedAt: 1,
            state: "queued",
            message: { role: "user", content: "next" },
          },
        ],
        total: 1,
      };
      const pendingBytes = Buffer.byteLength(JSON.stringify(pendingInputs));
      const older = {
        role: "user",
        content: "older",
        __openclaw: { id: "older", seq: 1 },
      };
      const anchor = {
        role: "assistant",
        content: Array.from({ length: 21 }, (_, index) => ({
          type: "text",
          text: index < 20 ? "x".repeat(4_000) : "",
        })),
        __openclaw: { id: "anchor", seq: 2 },
      };
      const messages = [older, anchor];
      const padding =
        80 * 1024 - pendingBytes - Buffer.byteLength(JSON.stringify(messages)) + excess;
      expect(padding).toBeGreaterThan(0);
      expect(padding).toBeLessThanOrEqual(4_000);
      anchor.content[20]!.text = "x".repeat(padding);
      const tool = createSessionsHistoryTool({
        config: {},
        callGateway: async <T = Record<string, unknown>>(): Promise<T> =>
          ({ messages, pendingInputs, totalMessages: messages.length }) as T,
      });

      const result = await tool.execute("anchored-pending-boundary", {
        sessionKey: "main",
        messageId: "anchor",
      });
      const expectedMessages = excess === 0 ? messages : [anchor];
      expect(result.details).toEqual({
        sessionKey: "main",
        messages: expectedMessages,
        truncated: excess === 1,
        droppedMessages: excess === 1,
        contentTruncated: false,
        contentRedacted: false,
        bytes: Buffer.byteLength(JSON.stringify(expectedMessages)) + pendingBytes,
        pendingInputs,
        totalMessages: messages.length,
      });
      expect(readHistoryDetails(result).bytes).toBeLessThanOrEqual(80 * 1024);
    },
  );

  it("keeps oversized anchor metadata in the hard-cap placeholder", async () => {
    const tool = createSessionsHistoryTool({
      config: {},
      callGateway: async <T = Record<string, unknown>>(): Promise<T> =>
        ({
          messages: [
            {
              role: "user",
              content: Array.from({ length: 21 }, () => ({
                type: "text",
                text: "x".repeat(4_000),
              })),
              __openclaw: { id: "anchor", seq: 7 },
            },
          ],
        }) as T,
    });
    const messages = [
      {
        role: "assistant",
        content: "[sessions_history omitted: message too large]",
        __openclaw: { seq: 7, id: "anchor" },
      },
    ];
    const result = await tool.execute("oversized-anchor", {
      sessionKey: "main",
      messageId: "anchor",
    });

    expect(result.details).toEqual({
      sessionKey: "main",
      messages,
      truncated: true,
      droppedMessages: true,
      contentTruncated: false,
      contentRedacted: false,
      bytes: Buffer.byteLength(JSON.stringify(messages)),
    });
  });
});
