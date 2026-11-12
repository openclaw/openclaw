import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Value } from "typebox/value";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  ChatHistoryParamsSchema,
  ChatPendingInputsPageSchema,
} from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { createSessionVisibilityChecker } from "../../plugin-sdk/session-visibility.js";
import { deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { describeSessionLinkRule } from "../tool-description-presets.js";
import { compactToolOutputHint } from "../tool-schema-hints.js";
import {
  type CallGatewayRequest,
  readHistoryDetails,
  readMessageId,
  requireGatewayRequest,
} from "./sessions-history-tool.test-support.js";

let createSessionsHistoryTool: typeof import("./sessions-history-tool.js").createSessionsHistoryTool;
let previousConfigPath: string | undefined;
let tempDir: string | undefined;
const SESSION_LINK_BASE = "http://127.0.0.1:18789/control";
const SESSION_LINK_RULE = describeSessionLinkRule(SESSION_LINK_BASE);

function useLoggingConfig(name: string, logging: Record<string, unknown>): void {
  if (!tempDir) {
    throw new Error("tempDir not initialized");
  }
  const configPath = path.join(tempDir, name);
  fs.writeFileSync(configPath, `${JSON.stringify({ logging })}\n`, "utf8");
  setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
}

function writeSessionStore(
  name: string,
  entries: Record<string, { sessionId: string; updatedAt: number; archivedAt?: number }>,
): string {
  if (!tempDir) {
    throw new Error("tempDir not initialized");
  }
  const storePath = path.join(tempDir, name);
  for (const [sessionKey, entry] of Object.entries(entries)) {
    replaceSessionEntrySync({ storePath, sessionKey }, entry);
  }
  return storePath;
}

function historyFixture(
  reply: Record<string, unknown> | ((request: CallGatewayRequest) => unknown),
  options: Parameters<typeof createSessionsHistoryTool>[0] = {},
) {
  const requests: CallGatewayRequest[] = [];
  const tool = createSessionsHistoryTool({
    config: {},
    ...options,
    callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
      requests.push(request);
      return (typeof reply === "function" ? reply(request) : reply) as T;
    },
  });
  return { tool, requests };
}

function createHistoryToolWithMessage(content: unknown, sessionLinkBase?: string) {
  return historyFixture(
    (request) =>
      request.method === "chat.history" ? { messages: [{ role: "user", content }] } : {},
    { sessionLinkBase },
  ).tool;
}

function scopedHistoryFixture(name: string, mutate?: (storePath: string) => void) {
  const requesterSessionKey = `agent:main:clickclack:${name}`;
  const targetSessionKey = "agent:main:main";
  const expectedSessionId = "main-incarnation";
  const storePath = writeSessionStore(`${name}.json`, {
    [targetSessionKey]: { sessionId: expectedSessionId, updatedAt: 1 },
  });
  let grantChecks = 0;
  const unregister = createSessionVisibilityChecker.registerScopedAccessProvider((request) => {
    if (
      request.requesterSessionKey !== requesterSessionKey ||
      request.targetSessionKey !== targetSessionKey
    ) {
      return undefined;
    }
    if (++grantChecks === 1) {
      mutate?.(storePath);
    }
    return { expectedSessionId };
  });
  const fixture = historyFixture(
    (request) =>
      request.method === "sessions.resolve"
        ? { key: targetSessionKey }
        : { messages: mutate ? [] : [{ role: "assistant", content: "visible" }] },
    {
      agentSessionKey: requesterSessionKey,
      sandboxed: true,
      config: {
        session: { store: storePath },
        tools: { sessions: { visibility: "self" } },
        agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
      },
    },
  );
  return { ...fixture, unregister, targetSessionKey };
}

function childHistoryFixture(name: string, replace = false) {
  const requesterSessionKey = "agent:main:subagent:parent";
  const targetSessionKey = `agent:main:subagent:${name}`;
  const expectedSessionId = "old-child-session";
  const storePath = writeSessionStore(`${name}.json`, {
    [targetSessionKey]: { sessionId: expectedSessionId, updatedAt: 1 },
  });
  const fixture = historyFixture(
    (request) => {
      if (request.method === "sessions.resolve") {
        const params = request.params as { spawnedBy?: unknown };
        return "spawnedBy" in params ? {} : { key: targetSessionKey, agentId: "main" };
      }
      if (request.method === "sessions.describe") {
        if (replace) {
          replaceSessionEntrySync(
            { storePath, sessionKey: targetSessionKey },
            { sessionId: "replacement-session", updatedAt: 2 },
          );
        }
        return {
          session: {
            key: targetSessionKey,
            sessionId: expectedSessionId,
            parentSessionKey: requesterSessionKey,
            // Older Gateways exposed the expired display projection alongside durable lineage.
            childOwnerSessionKeys: [],
          },
        };
      }
      if (!replace && request.method === "chat.history") {
        return { messages: [{ role: "assistant", content: "durable child history" }] };
      }
      throw new Error(`unexpected method: ${request.method}`);
    },
    {
      agentSessionKey: requesterSessionKey,
      config: { session: { store: storePath }, tools: { sessions: { visibility: "tree" } } },
    },
  );
  return { ...fixture, targetSessionKey };
}

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

it("declares complete success and closed error contracts", async () => {
  const tool = createHistoryToolWithMessage("hello");
  const result = await tool.execute("contract", { sessionKey: "main" });
  const linkedResult = await createHistoryToolWithMessage("hello", SESSION_LINK_BASE).execute(
    "linked-contract",
    { sessionKey: "main" },
  );

  expect(tool.outputSchema).toBeDefined();
  expect(Value.Check(tool.parameters, { sessionKey: "main", limit: 1000 })).toBe(true);
  expect(Value.Check(tool.parameters, { sessionKey: "main", limit: 1001 })).toBe(false);
  expect(Value.Check(ChatHistoryParamsSchema, { sessionKey: "main", limit: 1001 })).toBe(false);
  expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
  expect(result.details).not.toHaveProperty("sessionLinkRule");
  expect(linkedResult.details).toHaveProperty("sessionLinkRule", SESSION_LINK_RULE);
  expect(Value.Check(tool.outputSchema!, { status: "error", error: "missing" })).toBe(true);
  expect(
    Value.Check(tool.outputSchema!, { status: "forbidden", error: "hidden", extra: true }),
  ).toBe(false);
  const pendingInputs = {
    items: [
      {
        id: "pending-1",
        runId: "run-1",
        message: { role: "user", content: "next" },
        acceptedAt: 1,
        state: "queued",
        queued: true,
      },
      {
        id: "pending-stopped",
        message: { role: "user", content: "Stopped before execution" },
        acceptedAt: 2,
        state: "cancelled",
        cancelledByUser: true,
      },
    ],
    total: 2,
    queuedCount: 1,
  };
  expect(Value.Check(ChatPendingInputsPageSchema, pendingInputs)).toBe(true);
  expect(Value.Check(tool.outputSchema!, { ...readHistoryDetails(result), pendingInputs })).toBe(
    true,
  );
  expect(compactToolOutputHint(tool.outputSchema)).toBe(
    '{ bytes: number; contentRedacted: boolean; contentTruncated: boolean; droppedMessages: boolean; messages: Array<unknown>; sessionKey: string; truncated: boolean; hasMore?: boolean; nextOffset?: number; offset?: number; pendingInputs?: { items: Array<{ acceptedAt: number; id: string; message: unknown; state: "queued" | "cancelled" | "interrupted"; cancelledByUser?: true; queued?: true; runId?: string }>; total: number; nextBefore?: number; queuedCount?: number }; sessionLinkRule?: string; totalMessages?: number; windowReset?: boolean } | { error: string; status: "error" | "forbidden" }',
  );
});

it.each(["all", "self"] as const)(
  "conceals missing keys according to %s visibility",
  async (visibility) => {
    const sessionKey = "agent:main:missing";
    const { tool, requests } = historyFixture(
      () => {
        throw new Error(`No session found: ${sessionKey}`);
      },
      {
        config: { tools: { sessions: { visibility } } },
        ...(visibility === "self" ? { agentSessionKey: "agent:main:main" } : {}),
      },
    );
    const result = await tool.execute("missing-explicit-key", { sessionKey });
    if (visibility === "all") {
      expect(result.details).toEqual({ status: "error", error: `No session found: ${sessionKey}` });
    } else {
      expect(result.details).toMatchObject({ status: "forbidden" });
    }
    expect(requests.map((request) => request.method)).toEqual(["sessions.resolve"]);
  },
);

it("returns an empty history for an existing explicit key", async () => {
  const sessionKey = "agent:main:empty";
  const { tool, requests } = historyFixture(
    (request) => (request.method === "sessions.resolve" ? { key: sessionKey } : { messages: [] }),
    { config: { tools: { sessions: { visibility: "all" } } } },
  );

  const result = await tool.execute("existing-empty-key", { sessionKey });

  expect(result.details).toMatchObject({
    sessionKey,
    messages: [],
    bytes: 2,
  });
  expect(requests.map((request) => request.method)).toEqual(["sessions.resolve", "chat.history"]);
});

it("does not apply log redaction patterns to recalled session text", async () => {
  useLoggingConfig("custom-patterns.json", {
    redactSensitive: "off",
    redactPatterns: [String.raw`\binternal-ticket-[A-Za-z0-9]+\b`],
  });
  const tool = createHistoryToolWithMessage("follow up on internal-ticket-AbC12345");

  const result = await tool.execute("call-1", { sessionKey: "main" });
  const serialized = JSON.stringify(result.details);

  expect(serialized).toContain("internal-ticket-AbC12345");
  expect(serialized).toContain("intern");
  expect((result.details as { contentRedacted?: unknown }).contentRedacted).toBe(false);
});

it("preserves recalled secret-shaped session text", async () => {
  const tool = createHistoryToolWithMessage("OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789");

  const result = await tool.execute("call-1", { sessionKey: "main" });
  const serialized = JSON.stringify(result.details);

  expect(serialized).toContain("sk-or-v1-abcdef0123456789");
  expect(serialized).toContain("OPENROUTER_API_KEY=");
  expect(result.details).toMatchObject({
    contentRedacted: false,
    contentTruncated: false,
    truncated: false,
  });
});

it("keeps accepted inputs separate, bounded, and addressable by their own cursor", async () => {
  const items = Array.from({ length: 20 }, (_, index) => ({
    id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
    runId: "do-not-expose-correlation",
    state: "interrupted",
    acceptedAt: 1_700_000_000_000,
    steerNow: { status: "available", tools: ["exec"] },
    message: {
      role: "user",
      content: `OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789 ${"queued input ".repeat(1000)}`,
    },
  }));
  const { tool, requests } = historyFixture({
    messages: [{ role: "assistant", content: "Canonical reply" }],
    pendingInputs: { items, total: 23, nextBefore: 4 },
  });
  const result = await tool.execute("pending-cursor", { sessionKey: "main", pendingBefore: 24 });
  const details = result.details as {
    messages: unknown[];
    pendingInputs: { items: unknown[]; total: number; nextBefore: number };
    contentRedacted: boolean;
    bytes: number;
  };
  expect(requireGatewayRequest(requests, "chat.history").params).toMatchObject({
    pendingBefore: 24,
  });
  expect(details.messages).toEqual([{ role: "assistant", content: "Canonical reply" }]);
  expect(details.pendingInputs).toMatchObject({ total: 23, nextBefore: 4 });
  expect(details.pendingInputs.items).toHaveLength(20);
  expect(Buffer.byteLength(JSON.stringify(details.pendingInputs))).toBeLessThanOrEqual(4096);
  expect(JSON.stringify(details.pendingInputs)).not.toContain("sk-or-v1-abcdef0123456789");
  expect(JSON.stringify(details.pendingInputs)).not.toContain("do-not-expose-correlation");
  expect(JSON.stringify(details.pendingInputs)).not.toContain("steerNow");
  expect(details.contentRedacted).toBe(false);
  expect(details.bytes).toBeLessThanOrEqual(80 * 1024);
  expect(Value.Check(tool.outputSchema!, details)).toBe(true);
});

it.each([
  { args: { limit: 0 }, error: "limit must be a positive integer" },
  { args: { offset: "1abc" }, error: "offset must be a non-negative integer" },
  { args: { sessionId: "session-1" }, error: "sessionId requires messageId" },
])("rejects invalid history arguments: $error", async ({ args, error }) => {
  const { tool, requests } = historyFixture({ messages: [] });
  await expect(tool.execute("call-1", { sessionKey: "main", ...args })).rejects.toThrow(error);
  expect(requests).toEqual([]);
});

it("requests explicit offset pages and returns continuation metadata", async () => {
  const { tool, requests } = historyFixture({
    messages: [
      { role: "user", content: "newer" },
      { role: "assistant", content: "latest" },
    ],
    offset: 0,
    nextOffset: 2,
    hasMore: true,
    totalMessages: 4,
  });

  const result = await tool.execute("call-1", { sessionKey: "main", limit: 2, offset: 0 });

  expect(requireGatewayRequest(requests, "chat.history")).toMatchObject({
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

it("requests history around a search result message id", async () => {
  const { tool, requests } = historyFixture({
    messages: [
      { role: "user", content: "before" },
      { role: "assistant", content: "matching message" },
      { role: "user", content: "after" },
    ],
  });

  const originalArgs = {
    sessionKey: "main",
    limit: 3,
    offset: 4,
    messageId: "matching-message",
    sessionId: "matching-session",
  };
  const args = { ...originalArgs };
  const result = await tool.execute("call-1", args);

  expect(requireGatewayRequest(requests, "chat.history")).toMatchObject({
    method: "chat.history",
    params: {
      sessionKey: "main",
      limit: 3,
      messageId: "matching-message",
      sessionId: "matching-session",
    },
  });
  expect(result.details).toMatchObject({
    messages: [{ content: "before" }, { content: "matching message" }, { content: "after" }],
  });
  expect(requireGatewayRequest(requests, "chat.history").params).not.toHaveProperty("offset");
  expect(result.details).not.toHaveProperty("offset");
  expect(args).toEqual(originalArgs);
});

it("keeps the anchored message when the history byte cap trims neighbors", async () => {
  const anchorId = "message-10";
  const messages = Array.from({ length: 30 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index + 1} ${"x".repeat(4_000)}`,
    __openclaw: { id: `message-${index + 1}`, seq: index + 1 },
  }));
  const { tool } = historyFixture({ messages, offset: 0, totalMessages: messages.length });

  const result = await tool.execute("call-1", {
    sessionKey: "main",
    messageId: anchorId,
  });
  const details = readHistoryDetails(result);
  const returnedMessages = details.messages as unknown[];

  expect(returnedMessages.length).toBeLessThan(messages.length);
  expect(returnedMessages.some((message) => readMessageId(message) === anchorId)).toBe(true);
  expect(details).toMatchObject({ truncated: true, droppedMessages: true });
  expect(details.offset).toBeUndefined();
  expect(details.nextOffset).toBeUndefined();
  expect(details.hasMore).toBeUndefined();
});

it("paginates history with default filtering and explicit tool inclusion", async () => {
  const visibleMessages = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "visible" },
        { type: "toolCall", id: "outer-call", name: "read", arguments: {} },
      ],
      __openclaw: { seq: 7 },
    },
    { role: "custom", customType: "notice", content: "visible notice", __openclaw: { seq: 8 } },
    {
      role: "assistant",
      content: "latest <tool_result>embedded tool text</tool_result>",
      __openclaw: { seq: 9 },
    },
  ];
  const messages = [
    { role: "tool", content: "hidden", __openclaw: { seq: 4 } },
    { role: "toolResult", content: "also hidden", __openclaw: { seq: 5 } },
    {
      role: "custom",
      customType: "openclaw.nested-tool.v1",
      display: true,
      content: [
        { type: "toolCall", id: "nested-call", name: "read", arguments: {} },
        {
          type: "toolResult",
          role: "toolResult",
          toolCallId: "nested-call",
          content: [{ type: "text", text: "nested output" }],
        },
      ],
      __openclaw: { seq: 6 },
    },
    ...visibleMessages,
  ];
  const { tool } = historyFixture({
    messages,
    offset: 0,
    nextOffset: 7,
    hasMore: true,
    totalMessages: 10,
  });

  for (const includeTools of [undefined, false]) {
    const details = readHistoryDetails(
      await tool.execute("without-tools", {
        sessionKey: "main",
        offset: 0,
        ...(includeTools === undefined ? {} : { includeTools }),
      }),
    );
    expect(details.messages).toEqual(visibleMessages);
    expect(details).toMatchObject({
      offset: 0,
      nextOffset: 4,
      hasMore: true,
      totalMessages: 10,
    });
  }

  const withTools = readHistoryDetails(
    await tool.execute("with-tools", { sessionKey: "main", offset: 0, includeTools: true }),
  );
  expect(withTools.messages).toEqual(messages);
  expect(withTools.nextOffset).toBe(7);
});

it.each([
  {
    name: "projected siblings from the same row",
    offset: 0,
    nextOffset: 2,
    messages: [
      { role: "assistant", content: "projected sibling", __openclaw: { seq: 8 } },
      { role: "assistant", content: "latest", __openclaw: { seq: 9 } },
    ],
  },
  {
    name: "advancing past an already-returned row",
    offset: 4,
    nextOffset: 5,
    messages: [{ role: "assistant", content: "visible", __openclaw: { seq: 7 } }],
  },
])("preserves the Gateway replay cursor: $name", async ({ messages, offset, nextOffset }) => {
  const pagination = { offset, nextOffset, hasMore: true, totalMessages: 10 };
  const { tool } = historyFixture({
    messages,
    ...pagination,
  });
  const result = await tool.execute("cursor-progress", { sessionKey: "main", offset });
  expect(result.details).toMatchObject(pagination);
});

it("reads an old child from its exact durable lineage row", async () => {
  const { tool, requests, targetSessionKey } = childHistoryFixture("old-child");

  const result = await tool.execute("old-child-history", {
    sessionKey: targetSessionKey,
    limit: 1,
  });

  expect(result.details).toMatchObject({
    sessionKey: targetSessionKey,
    messages: [{ role: "assistant", content: "durable child history" }],
  });
  expect(requests.map((request) => request.method)).toEqual([
    "sessions.resolve",
    "sessions.describe",
    "chat.history",
  ]);
});

it("rejects a durable history grant when the target incarnation changes", async () => {
  const { tool, requests, targetSessionKey } = childHistoryFixture("old-child-race", true);

  await expect(
    tool.execute("old-child-history-race", { sessionKey: targetSessionKey, maxChars: 64_000 }),
  ).rejects.toThrow(`Session "${targetSessionKey}" changed after access was granted.`);
  expect(requests.some((request) => request.method === "chat.history")).toBe(false);
});

it("honors a scoped incarnation grant through the sandbox visibility clamp", async () => {
  const { tool, requests, unregister, targetSessionKey } = scopedHistoryFixture("scoped-grant");
  try {
    const result = await tool.execute("scoped-grant", { sessionKey: targetSessionKey });

    expect(result.details).toMatchObject({
      sessionKey: targetSessionKey,
      messages: [{ role: "assistant", content: "visible" }],
    });
    expect(requests.map((request) => request.method)).toEqual(["chat.history"]);
  } finally {
    unregister();
  }
});

it.each([
  { name: "incarnation", patch: { sessionId: "replacement-incarnation", updatedAt: 2 } },
  { name: "archived", patch: { sessionId: "main-incarnation", updatedAt: 2, archivedAt: 2 } },
])("rejects a scoped grant when the target is $name before the read", async ({ name, patch }) => {
  const { tool, requests, unregister, targetSessionKey } = scopedHistoryFixture(
    `scoped-grant-${name}-race`,
    (storePath) => replaceSessionEntrySync({ storePath, sessionKey: "agent:main:main" }, patch),
  );
  try {
    await expect(
      tool.execute("scoped-grant-race", { sessionKey: targetSessionKey }),
    ).rejects.toThrow(`Session "${targetSessionKey}" changed after access was granted.`);
    expect(requests.some((request) => request.method === "chat.history")).toBe(false);
  } finally {
    unregister();
  }
});

it.each([
  { requested: "global", requester: "global", agentId: "ops", resolved: "global" },
  {
    requested: "current",
    requester: "agent:research:main",
    agentId: "research",
    resolved: "agent:research:main",
  },
])(
  "resolves $requested history under $agentId",
  async ({ requested, requester, agentId, resolved }) => {
    const { tool, requests } = historyFixture(
      { messages: [] },
      {
        agentSessionKey: requester,
        ...(requested === "current" ? { requesterAgentIdOverride: "research" } : {}),
        config: {
          session: { store: path.join(tempDir!, `owned-${requested}.sqlite`), scope: "global" },
          agents: {
            ownership: "explicit",
            defaults: { sessionStore: { agentId: "ops" } },
            entries: { ops: {}, research: {} },
          },
        },
      },
    );

    await tool.execute("owned-history", { sessionKey: requested });
    // A qualified key implies its owner; repeating the same id would re-gate
    // the read against the fixed-store owner (#164847).
    expect(requests).toContainEqual({
      method: "chat.history",
      params:
        requested === "current"
          ? { sessionKey: resolved }
          : expect.objectContaining({ sessionKey: resolved, agentId }),
    });
    if (requested === "current") {
      expect(requests.some((request) => request.method === "sessions.resolve")).toBe(false);
    }
  },
);

it.each([4000, 4001, 16000])(
  "recovers %i visible characters only when requested",
  async (length) => {
    const text = "x".repeat(length);
    const { tool, requests } = historyFixture({ messages: [{ role: "user", content: text }] });
    const baseline = readHistoryDetails(await tool.execute("default-text", { sessionKey: "main" }));
    expect(baseline.contentTruncated).toBe(length > 4000);
    const full = readHistoryDetails(
      await tool.execute("expanded-text", { sessionKey: "main", maxChars: 64000 }),
    );
    expect(full.messages).toEqual([{ role: "user", content: text }]);
    expect(full.contentTruncated).toBe(false);
    expect(requests.findLast((request) => request.method === "chat.history")?.params).toMatchObject(
      { maxChars: 64000 },
    );
  },
);

it("replays locally omitted expanded rows without skipping source positions", async () => {
  const messages = [1, 2, 3].map((seq) => ({
    role: "user",
    content: "x".repeat(40000),
    __openclaw: { id: "expanded-" + seq, seq },
  }));
  const { tool } = historyFixture((request) => {
    if (request.method !== "chat.history") {
      return {};
    }
    const offset = (request.params as { offset?: number }).offset ?? 0;
    return {
      messages: messages.slice(0, 3 - offset),
      offset,
      nextOffset: 3,
      hasMore: false,
      totalMessages: 3,
    };
  });
  const first = readHistoryDetails(
    await tool.execute("expanded-first", { sessionKey: "main", offset: 0, maxChars: 64000 }),
  );
  expect((first.messages as unknown[]).map(readMessageId)).toEqual(["expanded-2", "expanded-3"]);
  expect(first).toMatchObject({ droppedMessages: true, nextOffset: 2, hasMore: true });
  const second = readHistoryDetails(
    await tool.execute("expanded-second", {
      sessionKey: "main",
      offset: first.nextOffset,
      maxChars: 64000,
    }),
  );
  expect((second.messages as unknown[]).map(readMessageId)).toEqual(["expanded-1"]);
  expect(second.hasMore).toBe(false);
});

it("keeps indivisible oversized expanded text explicitly incomplete", async () => {
  const { tool } = historyFixture({
    messages: [
      { role: "user", content: "🦊".repeat(30000), __openclaw: { id: "large-visible", seq: 1 } },
    ],
    offset: 0,
    totalMessages: 1,
    hasMore: false,
  });
  const details = readHistoryDetails(
    await tool.execute("oversized-expanded", { sessionKey: "main", offset: 0, maxChars: 64000 }),
  );
  expect(details).toMatchObject({ truncated: true, droppedMessages: true });
  expect((details.messages as unknown[]).map(readMessageId)).toEqual(["large-visible"]);
  expect(JSON.stringify(details.messages)).toContain("message too large");
});

it("does not widen private cross-agent reads with expanded text", async () => {
  const { tool, requests } = historyFixture(
    { key: "agent:other:private", agentId: "other" },
    { agentSessionKey: "agent:main:main", config: { tools: { sessions: { visibility: "self" } } } },
  );
  const result = await tool.execute("private-expanded", {
    sessionKey: "agent:other:private",
    maxChars: 64_000,
  });
  expect(result.details).toMatchObject({ status: "forbidden" });
  expect(requests.some((request) => request.method === "chat.history")).toBe(false);
});

it("bounds opt-in text expansion in both schema and direct execution", async () => {
  const { tool, requests } = historyFixture({ messages: [] });
  expect(Value.Check(tool.parameters, { sessionKey: "main", maxChars: 64_000 })).toBe(true);
  expect(Value.Check(tool.parameters, { sessionKey: "main", maxChars: 64_001 })).toBe(false);
  await expect(
    tool.execute("over-expanded", { sessionKey: "main", maxChars: 64_001 }),
  ).rejects.toThrow("64000");
  expect(requests).toEqual([]);
});

it("does not expand reasoning or tool argument previews", async () => {
  const blocks = [
    { type: "thinking", thinking: "r".repeat(6000) },
    { type: "toolCall", partialJson: "a".repeat(6000), text: "c".repeat(6000) },
  ];
  const { tool } = historyFixture({ messages: [{ role: "assistant", content: blocks }] });
  const normal = readHistoryDetails(
    await tool.execute("normal-private-fields", { sessionKey: "main" }),
  );
  const expanded = readHistoryDetails(
    await tool.execute("expanded-private-fields", { sessionKey: "main", maxChars: 64000 }),
  );
  expect(expanded.messages).toEqual(normal.messages);
});

it("retains upstream display-cap incompleteness", async () => {
  const { tool } = historyFixture({
    messages: [
      {
        role: "assistant",
        content: "x".repeat(64000),
        __openclaw: { id: "upstream-clipped", truncated: true, reason: "display-cap" },
      },
    ],
  });
  const details = readHistoryDetails(
    await tool.execute("upstream-clipped", { sessionKey: "main", maxChars: 64000 }),
  );
  expect(details).toMatchObject({ contentTruncated: true, truncated: true });
});

it("marks a locally split source-row group incomplete rather than silently skipping siblings", async () => {
  const messages = [1, 2, 3].map((id) => ({
    role: "assistant",
    content: "x".repeat(40000),
    __openclaw: { id: "sibling-" + id, seq: 1 },
  }));
  const { tool } = historyFixture({ messages, offset: 0, totalMessages: 1, hasMore: false });
  const details = readHistoryDetails(
    await tool.execute("split-source-group", { sessionKey: "main", offset: 0, maxChars: 64000 }),
  );
  expect(details).toMatchObject({ truncated: true, droppedMessages: true });
  expect(details.messages).toHaveLength(1);
  expect(JSON.stringify(details.messages)).toContain("message too large");
});

it.each(["input_text", "output_text"])(
  "expands supported visible %s through real display projection",
  async (type) => {
    const { sanitizeChatHistoryMessage } =
      await import("../../gateway/chat-display-projection.sanitize.js");
    const source = { role: "assistant", content: [{ type, text: "v".repeat(6000) }] };
    const { tool } = historyFixture((request) =>
      request.method === "chat.history"
        ? {
            messages: [
              sanitizeChatHistoryMessage(source, (request.params as { maxChars?: number }).maxChars)
                .message,
            ],
          }
        : {},
    );
    const details = readHistoryDetails(
      await tool.execute("visible-variant", { sessionKey: "main", maxChars: 64000 }),
    );
    expect(JSON.stringify(details.messages)).toContain("v".repeat(6000));
    expect(details.contentTruncated).toBe(false);
  },
);

it("keeps reasoning-variant thinking at the existing upstream preview bound", async () => {
  const { sanitizeChatHistoryMessage } =
    await import("../../gateway/chat-display-projection.sanitize.js");
  const source = {
    role: "assistant",
    content: [{ type: "reasoning", thinking: "r".repeat(50000) }],
  };
  const { tool } = historyFixture((request) =>
    request.method === "chat.history"
      ? {
          messages: [
            sanitizeChatHistoryMessage(source, (request.params as { maxChars?: number }).maxChars)
              .message,
          ],
        }
      : {},
  );
  const normal = readHistoryDetails(
    await tool.execute("reasoning-default", { sessionKey: "main" }),
  );
  const expanded = readHistoryDetails(
    await tool.execute("reasoning-expanded", { sessionKey: "main", maxChars: 64000 }),
  );
  expect(expanded.messages).toEqual(normal.messages);
  expect(JSON.stringify(expanded.messages)).not.toContain("r".repeat(8001));
});

it.each([
  { role: "tool" },
  { role: "toolResult" },
  { role: "tool_result" },
  { role: "function" },
  { role: "custom", toolName: "read", toolCallId: "read-1" },
])("preserves $role result previews when visible text expands", async (envelope) => {
  const text = "t".repeat(6000);
  const { tool } = historyFixture({
    messages: [
      { ...envelope, content: text },
      { ...envelope, content: [{ type: "text", text }] },
      { ...envelope, text },
    ],
  });
  const normal = readHistoryDetails(
    await tool.execute("normal-result-preview", { sessionKey: "main", includeTools: true }),
  );
  const expanded = readHistoryDetails(
    await tool.execute("expanded-result-preview", {
      sessionKey: "main",
      includeTools: true,
      maxChars: 64000,
    }),
  );
  expect(expanded.messages).toEqual(normal.messages);
});

it("does not shrink reasoning and tool previews when visible text is shortened", async () => {
  const { sanitizeChatHistoryMessage } =
    await import("../../gateway/chat-display-projection.sanitize.js");
  const source = {
    role: "assistant",
    content: [
      { type: "text", text: "v".repeat(200) },
      { type: "reasoning", thinking: "r".repeat(6000) },
      { type: "thinking", thinking: "s".repeat(6000) },
      { type: "toolCall", partialJson: "a".repeat(6000), text: "c".repeat(6000) },
    ],
  };
  const { tool } = historyFixture((request) =>
    request.method === "chat.history"
      ? {
          messages: [
            sanitizeChatHistoryMessage(source, (request.params as { maxChars?: number }).maxChars)
              .message,
          ],
        }
      : {},
  );
  const normal = readHistoryDetails(await tool.execute("normal-previews", { sessionKey: "main" }));
  const shortened = readHistoryDetails(
    await tool.execute("shortened-visible", { sessionKey: "main", maxChars: 100 }),
  );
  const normalMessage = (normal.messages as (typeof source)[])[0];
  const shortenedMessage = (shortened.messages as (typeof source)[])[0];
  expect(shortenedMessage?.content.slice(1)).toEqual(normalMessage?.content.slice(1));
  expect(shortenedMessage?.content[0]?.text).toBe("v".repeat(100) + "\n…(truncated)…");
});

it("preserves nested tool-result content at the upstream preview bound", async () => {
  const { sanitizeChatHistoryMessage } =
    await import("../../gateway/chat-display-projection.sanitize.js");
  const source = {
    role: "custom",
    customType: "openclaw.nested-tool.v1",
    content: [{ type: "toolResult", content: [{ type: "text", text: "n".repeat(20000) }] }],
  };
  const { tool } = historyFixture((request) =>
    request.method === "chat.history"
      ? {
          messages: [
            sanitizeChatHistoryMessage(source, (request.params as { maxChars?: number }).maxChars)
              .message,
          ],
        }
      : {},
  );
  const normal = readHistoryDetails(
    await tool.execute("normal-nested-preview", { sessionKey: "main", includeTools: true }),
  );
  const expanded = readHistoryDetails(
    await tool.execute("expanded-nested-preview", {
      sessionKey: "main",
      includeTools: true,
      maxChars: 64000,
    }),
  );
  expect(expanded.messages).toEqual(normal.messages);
  expect(expanded.contentTruncated).toBe(true);
});
