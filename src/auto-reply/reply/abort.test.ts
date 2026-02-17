import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  getAbortMemory,
  getAbortMemorySizeForTest,
  isAbortTrigger,
  resetAbortMemoryForTest,
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
  listSubagentRunsForRequester: vi.fn(() => []),
  markSubagentRunTerminated: vi.fn(() => 1),
}));

vi.mock("../../agents/subagent-registry.js", () => ({
  listSubagentRunsForRequester: subagentRegistryMocks.listSubagentRunsForRequester,
  markSubagentRunTerminated: subagentRegistryMocks.markSubagentRunTerminated,
}));

describe("abort detection", () => {
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

  it("fast-aborts even when text commands are disabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-abort-"));
    const storePath = path.join(root, "sessions.json");
    const cfg = { session: { store: storePath }, commands: { text: false } } as OpenClawConfig;

    const result = await tryFastAbortFromMessage({
      ctx: buildTestCtx({
        CommandBody: "/stop",
        RawBody: "/stop",
        CommandAuthorized: true,
        SessionKey: "telegram:123",
        Provider: "telegram",
        Surface: "telegram",
        From: "telegram:123",
        To: "telegram:123",
      }),
      cfg,
    });

    expect(result.handled).toBe(true);
  });

  it("fast-abort clears queued followups and session lane", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-abort-"));
    const storePath = path.join(root, "sessions.json");
    const cfg = { session: { store: storePath } } as OpenClawConfig;
    const sessionKey = "telegram:123";
    const sessionId = "session-123";
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId,
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
    );
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

    const result = await tryFastAbortFromMessage({
      ctx: buildTestCtx({
        CommandBody: "/stop",
        RawBody: "/stop",
        CommandAuthorized: true,
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
        From: "telegram:123",
        To: "telegram:123",
      }),
      cfg,
    });

    expect(result.handled).toBe(true);
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expect(commandQueueMocks.clearCommandLane).toHaveBeenCalledWith(`session:${sessionKey}`);
  });

  it("fast-abort stops active subagent runs for requester session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-abort-"));
    const storePath = path.join(root, "sessions.json");
    const cfg = { session: { store: storePath } } as OpenClawConfig;
    const sessionKey = "telegram:parent";
    const childKey = "agent:main:subagent:child-1";
    const sessionId = "session-parent";
    const childSessionId = "session-child";
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId,
            updatedAt: Date.now(),
          },
          [childKey]: {
            sessionId: childSessionId,
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
    );

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

    const result = await tryFastAbortFromMessage({
      ctx: buildTestCtx({
        CommandBody: "/stop",
        RawBody: "/stop",
        CommandAuthorized: true,
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
        From: "telegram:parent",
        To: "telegram:parent",
      }),
      cfg,
    });

    expect(result.stoppedSubagents).toBe(1);
    expect(commandQueueMocks.clearCommandLane).toHaveBeenCalledWith(`session:${childKey}`);
  });

  it("cascade stop kills depth-2 children when stopping depth-1 agent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-abort-"));
    const storePath = path.join(root, "sessions.json");
    const cfg = { session: { store: storePath } } as OpenClawConfig;
    const sessionKey = "telegram:parent";
    const depth1Key = "agent:main:subagent:child-1";
    const depth2Key = "agent:main:subagent:child-1:subagent:grandchild-1";
    const sessionId = "session-parent";
    const depth1SessionId = "session-child";
    const depth2SessionId = "session-grandchild";
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId,
            updatedAt: Date.now(),
          },
          [depth1Key]: {
            sessionId: depth1SessionId,
            updatedAt: Date.now(),
          },
          [depth2Key]: {
            sessionId: depth2SessionId,
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
    );

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

    const result = await tryFastAbortFromMessage({
      ctx: buildTestCtx({
        CommandBody: "/stop",
        RawBody: "/stop",
        CommandAuthorized: true,
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
        From: "telegram:parent",
        To: "telegram:parent",
      }),
      cfg,
    });

    // Should stop both depth-1 and depth-2 agents (cascade)
    expect(result.stoppedSubagents).toBe(2);
    expect(commandQueueMocks.clearCommandLane).toHaveBeenCalledWith(`session:${depth1Key}`);
    expect(commandQueueMocks.clearCommandLane).toHaveBeenCalledWith(`session:${depth2Key}`);
  });

  it("cascade stop traverses ended depth-1 parents to stop active depth-2 children", async () => {
    subagentRegistryMocks.listSubagentRunsForRequester.mockReset();
    subagentRegistryMocks.markSubagentRunTerminated.mockClear();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-abort-"));
    const storePath = path.join(root, "sessions.json");
    const cfg = { session: { store: storePath } } as OpenClawConfig;
    const sessionKey = "telegram:parent";
    const depth1Key = "agent:main:subagent:child-ended";
    const depth2Key = "agent:main:subagent:child-ended:subagent:grandchild-active";
    const now = Date.now();
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId: "session-parent",
            updatedAt: now,
          },
          [depth1Key]: {
            sessionId: "session-child-ended",
            updatedAt: now,
          },
          [depth2Key]: {
            sessionId: "session-grandchild-active",
            updatedAt: now,
          },
        },
        null,
        2,
      ),
    );

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

    const result = await tryFastAbortFromMessage({
      ctx: buildTestCtx({
        CommandBody: "/stop",
        RawBody: "/stop",
        CommandAuthorized: true,
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
        From: "telegram:parent",
        To: "telegram:parent",
      }),
      cfg,
    });

    // Should skip killing the ended depth-1 run itself, but still kill depth-2.
    expect(result.stoppedSubagents).toBe(1);
    expect(commandQueueMocks.clearCommandLane).toHaveBeenCalledWith(`session:${depth2Key}`);
    expect(subagentRegistryMocks.markSubagentRunTerminated).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-2", childSessionKey: depth2Key }),
    );
  });
});
