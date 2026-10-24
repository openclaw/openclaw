import "../../test-utils/prepare-compiled-subprocesses.js";
import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { expect, it } from "vitest";
import { createSessionsHistoryTool } from "./sessions-history-tool.js";
import {
  type CallGatewayRequest,
  readHistoryDetails,
  readMessageId,
  requireGatewayRequest,
} from "./sessions-history-tool.test-support.js";

const historyDetails = (messages: unknown[], truncated = false, extra = {}) => ({
  sessionKey: "main",
  messages,
  truncated,
  droppedMessages: truncated,
  contentTruncated: false,
  contentRedacted: false,
  bytes: Buffer.byteLength(JSON.stringify(messages)),
  ...extra,
});

it("sessions_history serializes each message once while growing a 512-message anchored window", async () => {
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

  const expected = historyDetails(messages, false, { totalMessages: messages.length });
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

type BudgetCase = [
  name: string,
  blocks: number[],
  anchorIndex: number,
  expectedIndices: number[],
  options?: { excess?: number; placeholder?: boolean },
];
const cases: BudgetCase[] = [
  ["grows older first", [10, 10, 10], 1, [0, 1]],
  ["continues newer when older is blocked", [21, 0, 0], 1, [1, 2]],
  ["continues older when newer is blocked", [0, 0, 0, 21, 0], 2, [0, 1, 2]],
  ...[0, 1].map((excess): BudgetCase => [
    `pending input budget excess ${excess}`,
    [0, 21],
    1,
    excess === 0 ? [0, 1] : [1],
    { excess },
  ]),
  ["retains oversized anchor metadata in a placeholder", [21], 0, [], { placeholder: true }],
];
it.each(cases)(
  "%s",
  async (
    _name,
    blocks,
    anchorIndex,
    expectedIndices,
    { excess, placeholder }: NonNullable<BudgetCase[4]> = {},
  ) => {
    const messages = blocks.map((length, index) => ({
      role: placeholder || (excess !== undefined && index === 0) ? "user" : "assistant",
      content: length
        ? Array.from({ length }, () => ({ type: "text", text: "x".repeat(4_000) }))
        : `message-${index}`,
      __openclaw: {
        id: index === anchorIndex ? "anchor" : `message-${index}`,
        seq: placeholder ? 7 : index + 1,
      },
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
      const anchor = messages[anchorIndex]!;
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
      : expectedIndices.map((index) => messages[index]!);
    const truncated = placeholder === true || expectedMessages.length < messages.length;
    expect(result.details).toEqual(
      historyDetails(expectedMessages, truncated, {
        bytes: Buffer.byteLength(JSON.stringify(expectedMessages)) + pendingBytes,
        ...pending,
        ...pagination,
      }),
    );
    expect(readHistoryDetails(result).bytes).toBeLessThanOrEqual(80 * 1024);
  },
);
