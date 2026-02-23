import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../../agents/subagent-registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  getAbortMemory,
  getAbortMemorySizeForTest,
  isAbortRequestText,
  isAbortTrigger,
  resetAbortMemoryForTest,
  resolveSessionEntryForKey,
  setAbortMemory,
  tryFastAbortFromMessage,
} from "./abort.js";
import { enqueueFollowupRun, getFollowupQueueDepth, type FollowupRun } from "./queue.js";
import { initSessionState } from "./session.js";
import { buildTestCtx } from "./test-ctx.js";

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(true),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));

const commandQueueMocks = vi.hoisted(() => ({
  clearCommandLane: vi.fn(),
}));

vi.mock("../../process/command-queue.js", () => commandQueueMocks);

const subagentRegistryMocks = vi.hoisted(() => ({
  listSubagentRunsForRequester: vi.fn<(requesterSessionKey: string) => SubagentRunRecord[]>(
    () => [],
  ),
  markSubagentRunTerminated: vi.fn(() => 1),
}));

vi.mock("../../agents/subagent-registry.js", () => ({
  listSubagentRunsForRequester: subagentRegistryMocks.listSubagentRunsForRequester,
  markSubagentRunTerminated: subagentRegistryMocks.markSubagentRunTerminated,
}));

describe("abort detection", () => {
  async function writeSessionStore(
    storePath: string,
    sessionIdsByKey: Record<string, string>,
    nowMs = Date.now(),
  ) {
    const storeEntries = Object.fromEntries(
      Object.entries(sessionIdsByKey).map(([key, sessionId]) => [
        key,
        { sessionId, updatedAt: nowMs },
      ]),
    );
    await fs.writeFile(storePath, JSON.stringify(storeEntries, null, 2));
  }

  async function createAbortConfig(params?: {
    commandsTextEnabled?: boolean;
    sessionIdsByKey?: Record<string, string>;
    nowMs?: number;
  }) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-abort-"));
    const storePath = path.join(root, "sessions.json");
    const cfg = {
      session: { store: storePath },
      ...(typeof params?.commandsTextEnabled === "boolean"
        ? { commands: { text: params.commandsTextEnabled } }
        : {}),
    } as OpenClawConfig;
    if (params?.sessionIdsByKey) {
      await writeSessionStore(storePath, params.sessionIdsByKey, params.nowMs);
    }
    return { root, storePath, cfg };
  }

  async function runStopCommand(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    from: string;
    to: string;
  }) {
    return tryFastAbortFromMessage({
      ctx: buildTestCtx({
        CommandBody: "/stop",
        RawBody: "/stop",
        CommandAuthorized: true,
        SessionKey: params.sessionKey,
        Provider: "telegram",
        Surface: "telegram",
        From: params.from,
        To: params.to,
      }),
      cfg: params.cfg,
    });
  }

  afterEach(() => {
    resetAbortMemoryForTest();
  });

  it("triggerBodyNormalized extracts /stop from RawBody for abort detection", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-abort-"));
    const storePath = path.join(root, "sessions.json");
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const groupMessageCtx = {
      Body: `[Context]\nJake: /stop\n[from: Jake]`,
      RawBody: "/stop",
      ChatType: "group",
      SessionKey: "agent:main:whatsapp:group:g1",
    };

    const result = await initSessionState({
      ctx: groupMessageCtx,
      cfg,
      commandAuthorized: true,
    });

    // /stop is detected via exact match in handleAbort, not isAbortTrigger
    expect(result.triggerBodyNormalized).toBe("/stop");
  });

  it("isAbortTrigger matches bare word triggers (without slash)", () => {
    expect(isAbortTrigger("stop")).toBe(true);
    expect(isAbortTrigger("esc")).toBe(true);
    expect(isAbortTrigger("abort")).toBe(true);
    expect(isAbortTrigger("wait")).toBe(true);
    expect(isAbortTrigger("exit")).toBe(true);
    expect(isAbortTrigger("interrupt")).toBe(true);
    expect(isAbortTrigger("hello")).toBe(false);
    // /stop is NOT matched by isAbortTrigger - it's handled separately
    expect(isAbortTrigger("/stop")).toBe(false);
  });

  it("isAbortRequestText aligns abort command semantics", () => {
    expect(isAbortRequestText("/stop")).toBe(true);
    expect(isAbortRequestText("stop")).toBe(true);
    expect(isAbortRequestText("/stop@openclaw_bot", { botUsername: "openclaw_bot" })).toBe(true);

    expect(isAbortRequestText("/status")).toBe(false);
    expect(isAbortRequestText("stop please")).toBe(false);
    expect(isAbortRequestText("/abort")).toBe(false);
  });

  it("removes abort memory entry when flag is reset", () => {
    setAbortMemory("session-1", true);
    expect(getAbortMemory("session-1")).toBe(true);

    setAbortMemory("session-1", false);
    expect(getAbortMemory("session-1")).toBeUndefined();
    expect(getAbortMemorySizeForTest()).toBe(0);
  });

  it("caps abort memory tracking to a bounded max size", () => {
    for (let i = 0; i < 2105; i += 1) {
      setAbortMemory(`session-${i}`, true);
    }
    expect(getAbortMemorySizeForTest()).toBe(2000);
    expect(getAbortMemory("session-0")).toBeUndefined();
    expect(getAbortMemory("session-2104")).toBe(true);
  });

  it("resolves session entry when key exists in store", () => {
    const store = {
      "session-1": { sessionId: "abc", updatedAt: 0 },
    } as const;
    expect(resolveSessionEntryForKey(store, "session-1")).toEqual({
      entry: store["session-1"],
      key: "session-1",
    });
    expect(resolveSessionEntryForKey(store, "session-2")).toEqual({});
    expect(resolveSessionEntryForKey(undefined, "session-1")).toEqual({});
  });

  it("fast-aborts even when text commands are disabled", async () => {
    const { cfg } = await createAbortConfig({ commandsTextEnabled: false });

    const result = await runStopCommand({
      cfg,
      sessionKey: "telegram:123",
      from: "telegram:123",
      to: "telegram:123",
    });

    expect(result.handled).toBe(true);
  });

  it("fast-abort clears queued followups and session lane", async () => {
    const sessionKey = "telegram:123";
    const sessionId = "session-123";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    const followupRun: FollowupRun = {
      prompt: "queued",
      enqueuedAt: Date.now(),
      run: {
        agentId: "main",
        agentDir: path.join(root, "agent"),
        sessionId,
        sessionKey,
        messageProvider: "telegram",
        agentAccountId: "acct",
        sessionFile: path.join(root, "session.jsonl"),
        workspaceDir: path.join(root, "workspace"),
        config: cfg,
        provider: "anthropic",
        model: "claude-opus-4-5",
        timeoutMs: 1000,
        blockReplyBreak: "text_end",
      },
    };
    enqueueFollowupRun(
      sessionKey,
      followupRun,
      { mode: "collect", debounceMs: 0, cap: 20, dropPolicy: "summarize" },
      "none",
    );
    expect(getFollowupQueueDepth(sessionKey)).toBe(1);

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:123",
      to: "telegram:123",
    });

    expect(result.handled).toBe(true);
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expect(commandQueueMocks.clearCommandLane).toHaveBeenCalledWith(`session:${sessionKey}`);
  });

  it("fast-abort stops active subagent runs for requester session", async () => {
    const sessionKey = "telegram:parent";
    const childKey = "agent:main:subagent:child-1";
    const sessionId = "session-parent";
    const childSessionId = "session-child";
    const { cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [sessionKey]: sessionId,
        [childKey]: childSessionId,
      },
    });

    subagentRegistryMocks.listSubagentRunsForRequester.mockReturnValueOnce([
      {
        runId: "run-1",
        childSessionKey: childKey,
        requesterSessionKey: sessionKey,
        requesterDisplayKey: "telegram:parent",
        task: "do work",
        cleanup: "keep",
        createdAt: Date.now(),
      },
    ]);

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:parent",
      to: "telegram:parent",
    });

    expect(result.stoppedSubagents).toBe(1);
    expect(commandQueueMocks.clearCommandLane).toHaveBeenCalledWith(`session:${childKey}`);
  });

  it("cascade stop kills depth-2 children when stopping depth-1 agent", async () => {
    const sessionKey = "telegram:parent";
    const depth1Key = "agent:main:subagent:child-1";
    const depth2Key = "agent:main:subagent:child-1:subagent:grandchild-1";
    const sessionId = "session-parent";
    const depth1SessionId = "session-child";
    const depth2SessionId = "session-grandchild";
    const { cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [sessionKey]: sessionId,
        [depth1Key]: depth1SessionId,
        [depth2Key]: depth2SessionId,
      },
    });

    // First call: main session lists depth-1 children
    // Second call (cascade): depth-1 session lists depth-2 children
    // Third call (cascade from depth-2): no further children
    subagentRegistryMocks.listSubagentRunsForRequester
      .mockReturnValueOnce([
        {
          runId: "run-1",
          childSessionKey: depth1Key,
          requesterSessionKey: sessionKey,
          requesterDisplayKey: "telegram:parent",
          task: "orchestrator",
          cleanup: "keep",
          createdAt: Date.now(),
        },
      ])
      .mockReturnValueOnce([
        {
          runId: "run-2",
          childSessionKey: depth2Key,
          requesterSessionKey: depth1Key,
          requesterDisplayKey: depth1Key,
          task: "leaf worker",
          cleanup: "keep",
          createdAt: Date.now(),
        },
      ])
      .mockReturnValueOnce([]);

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:parent",
      to: "telegram:parent",
    });

    // Should stop both depth-1 and depth-2 agents (cascade)
    expect(result.stoppedSubagents).toBe(2);
    expect(commandQueueMocks.clearCommandLane).toHaveBeenCalledWith(`session:${depth1Key}`);
    expect(commandQueueMocks.clearCommandLane).toHaveBeenCalledWith(`session:${depth2Key}`);
  });

  it("cascade stop traverses ended depth-1 parents to stop active depth-2 children", async () => {
    subagentRegistryMocks.listSubagentRunsForRequester.mockClear();
    subagentRegistryMocks.markSubagentRunTerminated.mockClear();
    const sessionKey = "telegram:parent";
    const depth1Key = "agent:main:subagent:child-ended";
    const depth2Key = "agent:main:subagent:child-ended:subagent:grandchild-active";
    const now = Date.now();
    const { cfg } = await createAbortConfig({
      nowMs: now,
      sessionIdsByKey: {
        [sessionKey]: "session-parent",
        [depth1Key]: "session-child-ended",
        [depth2Key]: "session-grandchild-active",
      },
    });

    // main -> ended depth-1 parent
    // depth-1 parent -> active depth-2 child
    // depth-2 child -> none
    subagentRegistryMocks.listSubagentRunsForRequester
      .mockReturnValueOnce([
        {
          runId: "run-1",
          childSessionKey: depth1Key,
          requesterSessionKey: sessionKey,
          requesterDisplayKey: "telegram:parent",
          task: "orchestrator",
          cleanup: "keep",
          createdAt: now - 1_000,
          endedAt: now - 500,
          outcome: { status: "ok" },
        },
      ])
      .mockReturnValueOnce([
        {
          runId: "run-2",
          childSessionKey: depth2Key,
          requesterSessionKey: depth1Key,
          requesterDisplayKey: depth1Key,
          task: "leaf worker",
          cleanup: "keep",
          createdAt: now - 500,
        },
      ])
      .mockReturnValueOnce([]);

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:parent",
      to: "telegram:parent",
    });

    // Should skip killing the ended depth-1 run itself, but still kill depth-2.
    expect(result.stoppedSubagents).toBe(1);
    expect(commandQueueMocks.clearCommandLane).toHaveBeenCalledWith(`session:${depth2Key}`);
    expect(subagentRegistryMocks.markSubagentRunTerminated).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-2", childSessionKey: depth2Key }),
    );
  });
});
