import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot } from "../../config/config.js";
import {
  TERMINAL_READ_DEFAULT_MAX_CHARS,
  TERMINAL_READ_MAX_PAGE_CHARS,
} from "../../gateway/terminal/session-limits.js";
import { TerminalSessionManager } from "../../gateway/terminal/session-manager.js";
import {
  agentTerminalOwner,
  baseOpenRequest,
  makeFakePty,
} from "../../gateway/terminal/session-manager.test-helpers.js";
import { createTerminalTool } from "./terminal-tool.js";

const getInProcessGatewayToolContext = vi.hoisted(() => vi.fn());
// mock-isolation: paging tests inject their Gateway context, so the in-process resolver stays stubbed.
vi.mock("./in-process-gateway.js", () => ({ getInProcessGatewayToolContext }));

const agentOwner = agentTerminalOwner("agent:main:main", "main-session-id");

type TerminalReadDetails = {
  sessionId: string;
  text: string;
  startCursor: number;
  cursor: number;
  endCursor: number;
  truncated: boolean;
  hasMore: boolean;
};

async function openTerminal(options: { scrollbackChars?: number } = {}) {
  const backend = makeFakePty();
  const manager = new TerminalSessionManager({
    emit: vi.fn(),
    spawn: async () => backend,
    ...options,
  });
  const opened = await manager.open(
    baseOpenRequest({ owner: agentOwner, viewerConnId: "operator" }),
  );
  if (!opened.ok) {
    throw new Error("expected operator-opened terminal");
  }
  const tool = createTerminalTool({
    agentId: "main",
    agentSessionKey: agentOwner.agentSessionKey,
    sessionId: agentOwner.agentSessionId,
    execSession: {},
    getGatewayContext: () => ({ terminalSessions: manager }),
  });
  // The session opens with a rendered intro banner; offsets below are relative to it.
  const base = await readTerminal(tool, { sessionId: opened.sessionId });
  expect(base.hasMore).toBe(false);
  return { backend, manager, tool, sessionId: opened.sessionId, baseCursor: base.endCursor };
}

async function readTerminal(
  tool: ReturnType<typeof createTerminalTool>,
  params: Record<string, unknown>,
): Promise<TerminalReadDetails> {
  const result = await tool.execute("read", { action: "read", ...params });
  return result.details as TerminalReadDetails;
}

describe("terminal read cursor paging", () => {
  beforeEach(() => {
    getInProcessGatewayToolContext.mockReset();
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it("publishes cursors and reads only output produced after one", async () => {
    const { backend, tool, sessionId, baseCursor } = await openTerminal();

    backend.emitData("first line\r\n");
    const first = await readTerminal(tool, { sessionId, cursor: baseCursor });
    expect(first).toMatchObject({
      sessionId,
      text: "first line\n",
      startCursor: baseCursor,
      cursor: baseCursor + 12,
      endCursor: baseCursor + 12,
      truncated: false,
      hasMore: false,
    });
    expect(Value.Check(tool.outputSchema!, first)).toBe(true);

    backend.emitData("second line\r\n");
    const second = await readTerminal(tool, { sessionId, cursor: first.cursor });
    expect(second).toMatchObject({
      sessionId,
      text: "second line\n",
      startCursor: baseCursor + 12,
      cursor: baseCursor + 25,
      endCursor: baseCursor + 25,
      truncated: false,
      hasMore: false,
    });
    expect(Value.Check(tool.outputSchema!, second)).toBe(true);

    // A follow read with an up-to-date cursor is empty rather than a replay.
    expect(await readTerminal(tool, { sessionId, cursor: second.cursor })).toMatchObject({
      text: "",
      startCursor: baseCursor + 25,
      cursor: baseCursor + 25,
      hasMore: false,
    });
  });

  it("bounds a cursorless read to the newest output and reports where it starts", async () => {
    const { backend, tool, sessionId, baseCursor } = await openTerminal();
    const total = TERMINAL_READ_DEFAULT_MAX_CHARS + 1024;

    backend.emitData("a".repeat(total));
    const page = await readTerminal(tool, { sessionId });

    expect(page.text).toHaveLength(TERMINAL_READ_DEFAULT_MAX_CHARS);
    expect(page).toMatchObject({
      sessionId,
      text: "a".repeat(TERMINAL_READ_DEFAULT_MAX_CHARS),
      // The page starts past the oldest retained output, which paging back reaches.
      startCursor: baseCursor + 1024,
      cursor: baseCursor + total,
      endCursor: baseCursor + total,
      truncated: false,
      hasMore: false,
    });
    expect(await readTerminal(tool, { sessionId, cursor: baseCursor, maxChars: 16 })).toMatchObject(
      {
        text: "a".repeat(16),
        startCursor: baseCursor,
        hasMore: true,
      },
    );
  });

  it("honors maxChars and reports unread output through hasMore", async () => {
    const { backend, tool, sessionId, baseCursor } = await openTerminal();

    backend.emitData("abcdefghijklmnopqrstuvwxyz");
    const first = await readTerminal(tool, { sessionId, cursor: baseCursor, maxChars: 10 });
    expect(first).toMatchObject({
      sessionId,
      text: "abcdefghij",
      startCursor: baseCursor,
      cursor: baseCursor + 10,
      endCursor: baseCursor + 26,
      truncated: false,
      hasMore: true,
    });

    const second = await readTerminal(tool, { sessionId, cursor: first.cursor, maxChars: 100 });
    expect(second).toMatchObject({
      text: "klmnopqrstuvwxyz",
      startCursor: baseCursor + 10,
      cursor: baseCursor + 26,
      hasMore: false,
    });
  });

  it("reports an evicted cursor as truncated instead of replaying retained output", async () => {
    const { backend, tool, sessionId, baseCursor } = await openTerminal({ scrollbackChars: 64 });

    backend.emitData("x".repeat(200));
    const page = await readTerminal(tool, { sessionId, cursor: 0 });

    expect(page).toMatchObject({
      sessionId,
      text: "x".repeat(64),
      startCursor: baseCursor + 136,
      cursor: baseCursor + 200,
      endCursor: baseCursor + 200,
      truncated: true,
      hasMore: false,
    });
  });

  it("keeps surrogate pairs whole when a page cut would split one", async () => {
    const { backend, tool, sessionId, baseCursor } = await openTerminal();

    backend.emitData("ok\u{1f642}\r\n");
    const page = await readTerminal(tool, { sessionId, cursor: baseCursor + 2, maxChars: 1 });

    // One raw unit cannot carry the pair, so the page widens instead of splitting it.
    expect(page).toMatchObject({
      text: "\u{1f642}",
      startCursor: baseCursor + 2,
      cursor: baseCursor + 4,
      endCursor: baseCursor + 6,
      truncated: false,
      hasMore: true,
    });
    expect(await readTerminal(tool, { sessionId, cursor: page.cursor })).toMatchObject({
      text: "\n",
      startCursor: baseCursor + 4,
      cursor: baseCursor + 6,
      hasMore: false,
    });
  });

  it("advertises the paging parameters and rejects out-of-range pages", async () => {
    const { tool, sessionId } = await openTerminal();

    expect(tool.parameters).toMatchObject({
      properties: {
        cursor: { type: "integer", minimum: 0 },
        maxChars: { type: "integer", minimum: 1, maximum: TERMINAL_READ_MAX_PAGE_CHARS },
      },
    });
    await expect(tool.execute("read", { action: "read", sessionId, cursor: -1 })).rejects.toThrow(
      /cursor must be a non-negative integer/,
    );
    for (const maxChars of [0, TERMINAL_READ_MAX_PAGE_CHARS + 1, 1.5]) {
      await expect(tool.execute("read", { action: "read", sessionId, maxChars })).rejects.toThrow(
        /maxChars/,
      );
    }
  });
});
