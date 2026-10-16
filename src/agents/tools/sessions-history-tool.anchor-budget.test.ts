import "../../test-utils/prepare-compiled-subprocesses.js";
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

  const cases: Array<{
    name: string;
    ids: string[];
    large: string[];
    blocks: number;
    expectedIds: string[];
    excess?: number;
    placeholder?: boolean;
  }> = [
    {
      name: "grows older first",
      ids: ["older", "anchor", "newer"],
      large: ["older", "anchor", "newer"],
      blocks: 10,
      expectedIds: ["older", "anchor"],
    },
    {
      name: "continues newer when older is blocked",
      ids: ["blocked-older", "anchor", "newer"],
      large: ["blocked-older"],
      blocks: 21,
      expectedIds: ["anchor", "newer"],
    },
    {
      name: "continues older when newer is blocked",
      ids: ["oldest", "older", "anchor", "blocked-newer", "latest"],
      large: ["blocked-newer"],
      blocks: 21,
      expectedIds: ["oldest", "older", "anchor"],
    },
    ...[0, 1].map((excess) => ({
      name: `pending input budget excess ${excess}`,
      ids: ["older", "anchor"],
      large: ["anchor"],
      blocks: 21,
      expectedIds: excess === 0 ? ["older", "anchor"] : ["anchor"],
      excess,
    })),
    {
      name: "retains oversized anchor metadata in a placeholder",
      ids: ["anchor"],
      large: ["anchor"],
      blocks: 21,
      expectedIds: [],
      placeholder: true,
    },
  ];
  it.each(cases)("$name", async ({ ids, large, blocks, expectedIds, excess, placeholder }) => {
    const messages = ids.map((id, index) => ({
      role: placeholder || (excess !== undefined && id === "older") ? "user" : "assistant",
      content: large.includes(id)
        ? Array.from({ length: blocks }, () => ({ type: "text", text: "x".repeat(4_000) }))
        : id,
      __openclaw: { id, seq: placeholder ? 7 : index + 1 },
    }));
    const pendingInputs =
      excess === undefined
        ? undefined
        : {
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
    const pendingBytes = pendingInputs ? Buffer.byteLength(JSON.stringify(pendingInputs)) : 0;
    if (excess !== undefined) {
      const anchor = messages[1]!;
      if (!Array.isArray(anchor.content)) {
        throw new Error("Expected anchor text blocks");
      }
      anchor.content[20]!.text = "";
      const padding =
        80 * 1024 - pendingBytes - Buffer.byteLength(JSON.stringify(messages)) + excess;
      expect(padding).toBeGreaterThan(0);
      expect(padding).toBeLessThanOrEqual(4_000);
      anchor.content[20]!.text = "x".repeat(padding);
    }
    const pagination = placeholder ? {} : { totalMessages: messages.length };
    const pending = pendingInputs ? { pendingInputs } : {};
    const tool = createSessionsHistoryTool({
      config: {},
      callGateway: async <T = Record<string, unknown>>(): Promise<T> =>
        ({ messages, ...pending, ...pagination }) as T,
    });
    const result = await tool.execute("anchored-budget", {
      sessionKey: "main",
      messageId: "anchor",
    });
    const expectedMessages = placeholder
      ? [
          {
            role: "assistant",
            content: "[sessions_history omitted: message too large]",
            __openclaw: { seq: 7, id: "anchor" },
          },
        ]
      : messages.filter((message) => expectedIds.includes(readMessageId(message) ?? ""));
    const truncated = placeholder === true || expectedMessages.length < messages.length;
    expect(result.details).toEqual({
      sessionKey: "main",
      messages: expectedMessages,
      truncated,
      droppedMessages: truncated,
      contentTruncated: false,
      contentRedacted: false,
      bytes: Buffer.byteLength(JSON.stringify(expectedMessages)) + pendingBytes,
      ...pending,
      ...pagination,
    });
    expect(readHistoryDetails(result).bytes).toBeLessThanOrEqual(80 * 1024);
  });
});
