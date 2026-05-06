import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cancelPendingDelegates,
  consumePendingDelegates,
  consumeStagedPostCompactionDelegates,
} from "../../auto-reply/continuation-delegate-store.js";
import {
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../config/config.js";
import { createContinueDelegateTool } from "./continue-delegate-tool.js";

const VALID_TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("continue_delegate tool", () => {
  beforeEach(() => {
    cancelPendingDelegates("test-session");
    consumePendingDelegates("test-session");
    consumeStagedPostCompactionDelegates("test-session");
    clearRuntimeConfigSnapshot();
  });

  afterEach(() => {
    cancelPendingDelegates("test-session");
    clearRuntimeConfigSnapshot();
  });

  async function executeTool(
    tool: ReturnType<typeof createContinueDelegateTool>,
    index: number,
    args: Record<string, unknown>,
  ) {
    return (await tool.execute(`call-${index}`, args))?.details as Record<string, unknown>;
  }

  it("reads maxDelegatesPerTurn at execute time instead of tool construction time", async () => {
    const initialConfig: OpenClawConfig = {
      agents: { defaults: { continuation: { maxDelegatesPerTurn: 5 } } },
    };
    setRuntimeConfigSnapshot(initialConfig);
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    const updatedConfig: OpenClawConfig = {
      agents: { defaults: { continuation: { maxDelegatesPerTurn: 10 } } },
    };
    setRuntimeConfigSnapshot(updatedConfig);

    for (let index = 0; index < 10; index += 1) {
      const result = await executeTool(tool, index, { task: `delegate ${index + 1}` });
      expect(result).toMatchObject({ status: "scheduled" });
    }

    const overflow = await executeTool(tool, 10, { task: "delegate 11" });
    expect(overflow).toMatchObject({
      status: "error",
      limit: 10,
    });
  });

  it("re-reads maxDelegatesPerTurn on each call", async () => {
    const initialConfig: OpenClawConfig = {
      agents: { defaults: { continuation: { maxDelegatesPerTurn: 10 } } },
    };
    setRuntimeConfigSnapshot(initialConfig);
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    for (let index = 0; index < 5; index += 1) {
      const result = await executeTool(tool, index, { task: `delegate ${index + 1}` });
      expect(result).toMatchObject({ status: "scheduled" });
    }

    const updatedConfig: OpenClawConfig = {
      agents: { defaults: { continuation: { maxDelegatesPerTurn: 5 } } },
    };
    setRuntimeConfigSnapshot(updatedConfig);

    const overflow = await executeTool(tool, 5, { task: "delegate 6" });
    expect(overflow).toMatchObject({
      status: "error",
      limit: 5,
    });
  });

  it("uses the runtime default of 5 when maxDelegatesPerTurn is unset", async () => {
    // Pin an empty config so the test doesn't pick up host-level openclaw.json.
    setRuntimeConfigSnapshot({});
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    for (let index = 0; index < 5; index += 1) {
      const result = await executeTool(tool, index, { task: `delegate ${index + 1}` });
      expect(result).toMatchObject({ status: "scheduled" });
    }

    const overflow = await executeTool(tool, 5, { task: "delegate 6" });
    expect(overflow).toMatchObject({
      status: "error",
      limit: 5,
    });
  });

  it("does not let far-future queued delegates consume a fresh turn budget", async () => {
    setRuntimeConfigSnapshot({
      agents: { defaults: { continuation: { maxDelegatesPerTurn: 2 } } },
    });
    const firstTurnTool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    await expect(
      executeTool(firstTurnTool, 0, {
        task: "delayed delegate 1",
        delaySeconds: 86_400,
      }),
    ).resolves.toMatchObject({ status: "scheduled", delegatesThisTurn: 1 });
    await expect(
      executeTool(firstTurnTool, 1, {
        task: "delayed delegate 2",
        delaySeconds: 86_400,
      }),
    ).resolves.toMatchObject({ status: "scheduled", delegatesThisTurn: 2 });
    await expect(
      executeTool(firstTurnTool, 2, { task: "same-turn overflow" }),
    ).resolves.toMatchObject({
      status: "error",
      delegatesThisTurn: 2,
      limit: 2,
      pendingQueuedDelegates: 2,
      scheduledPendingDelegates: 2,
      stagedPostCompactionDelegates: 0,
    });

    const nextTurnTool = createContinueDelegateTool({ agentSessionKey: "test-session" });
    await expect(
      executeTool(nextTurnTool, 0, { task: "fresh turn immediate" }),
    ).resolves.toMatchObject({
      status: "scheduled",
      delegateIndex: 1,
      delegatesThisTurn: 1,
    });
    expect(consumePendingDelegates("test-session")).toEqual([
      expect.objectContaining({ task: "fresh turn immediate" }),
    ]);
  });

  it("accepts string-encoded delaySeconds values", async () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    const result = await executeTool(tool, 0, {
      task: "delayed delegate",
      delaySeconds: "5",
      mode: "silent",
    });

    expect(result).toMatchObject({
      status: "scheduled",
      delaySeconds: 5,
      mode: "silent",
    });
  });

  it("accepts mixed-case delegate mode values", async () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    const result = await executeTool(tool, 0, {
      task: "mixed-case mode delegate",
      mode: "Silent-Wake",
    });

    expect(result).toMatchObject({
      status: "scheduled",
      mode: "silent-wake",
    });
    expect(consumePendingDelegates("test-session")).toEqual([
      expect.objectContaining({ task: "mixed-case mode delegate", mode: "silent-wake" }),
    ]);
  });

  it("persists singular cross-session target metadata", async () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    const result = await executeTool(tool, 0, {
      task: "return to root",
      targetSessionKey: "agent:main:root",
    });

    expect(result).toMatchObject({
      status: "scheduled",
      targetSessionKey: "agent:main:root",
    });
    expect(consumePendingDelegates("test-session")).toEqual([
      expect.objectContaining({
        task: "return to root",
        targetSessionKey: "agent:main:root",
      }),
    ]);
  });

  it("persists multi-recipient target metadata from snake_case input", async () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    const result = await executeTool(tool, 0, {
      task: "return to siblings",
      target_session_keys: ["agent:main:root", " agent:main:sibling ", "agent:main:root"],
    });

    expect(result).toMatchObject({
      status: "scheduled",
      targetSessionKeys: ["agent:main:root", "agent:main:sibling"],
    });
    expect(consumePendingDelegates("test-session")).toEqual([
      expect.objectContaining({
        task: "return to siblings",
        targetSessionKeys: ["agent:main:root", "agent:main:sibling"],
      }),
    ]);
  });

  it("persists tree/all fanout metadata", async () => {
    const treeTool = createContinueDelegateTool({ agentSessionKey: "test-session" });
    const treeResult = await executeTool(treeTool, 0, {
      task: "return up the chain",
      fanoutMode: "tree",
    });

    expect(treeResult).toMatchObject({
      status: "scheduled",
      fanoutMode: "tree",
    });
    expect(consumePendingDelegates("test-session")).toEqual([
      expect.objectContaining({ task: "return up the chain", fanoutMode: "tree" }),
    ]);

    const allTool = createContinueDelegateTool({ agentSessionKey: "test-session" });
    const allResult = await executeTool(allTool, 0, {
      task: "return to everyone",
      fanout_mode: "ALL",
    });

    expect(allResult).toMatchObject({
      status: "scheduled",
      fanoutMode: "all",
    });
    expect(consumePendingDelegates("test-session")).toEqual([
      expect.objectContaining({ task: "return to everyone", fanoutMode: "all" }),
    ]);
  });

  it("persists a valid optional traceparent carrier", async () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    const result = await executeTool(tool, 0, {
      task: "continue traced chain",
      traceparent: VALID_TRACEPARENT,
    });

    expect(result).toMatchObject({
      status: "scheduled",
      traceparent: VALID_TRACEPARENT,
    });
    expect(consumePendingDelegates("test-session")).toEqual([
      expect.objectContaining({
        task: "continue traced chain",
        traceparent: VALID_TRACEPARENT,
      }),
    ]);
  });

  it("rejects malformed traceparent carriers", async () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    await expect(
      tool.execute("call-bad-traceparent", {
        task: "continue malformed traced chain",
        traceparent: "not-a-traceparent",
      }),
    ).rejects.toThrow("traceparent must be a valid W3C traceparent header");
    expect(consumePendingDelegates("test-session")).toEqual([]);
  });

  it("omits traceparent when the carrier is absent", async () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    await executeTool(tool, 0, { task: "continue untraced chain" });

    const delegates = consumePendingDelegates("test-session");
    expect(delegates).toHaveLength(1);
    expect(delegates[0].traceparent).toBeUndefined();
  });

  it("fails loudly for invalid target arrays and fanout conflicts", async () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    await expect(
      tool.execute("call-invalid-array", {
        task: "bad targets",
        targetSessionKeys: "agent:main:root",
      }),
    ).rejects.toThrow("targetSessionKeys must be an array of non-empty strings");

    await expect(
      tool.execute("call-invalid-entry", {
        task: "bad target entry",
        targetSessionKeys: ["agent:main:root", ""],
      }),
    ).rejects.toThrow("targetSessionKeys must contain only non-empty strings");

    await expect(
      tool.execute("call-conflict", {
        task: "conflicting targets",
        targetSessionKey: "agent:main:root",
        fanoutMode: "tree",
      }),
    ).rejects.toThrow("fanoutMode cannot be combined with targetSessionKey or targetSessionKeys");
  });

  it("stages post-compaction delegates as silent-wake delegates", async () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    const result = await executeTool(tool, 0, {
      task: "carry compacted working state forward",
      mode: "post-compaction",
    });

    expect(result).toMatchObject({
      status: "queued-for-compaction",
      mode: "post-compaction",
    });
    expect(consumeStagedPostCompactionDelegates("test-session")).toEqual([
      expect.objectContaining({
        task: "carry compacted working state forward",
        silent: true,
        silentWake: true,
      }),
    ]);
  });

  it("threads traceparent into staged post-compaction delegates", async () => {
    const tool = createContinueDelegateTool({ agentSessionKey: "test-session" });

    const result = await executeTool(tool, 0, {
      task: "carry traced compacted working state forward",
      mode: "post-compaction",
      traceparent: VALID_TRACEPARENT,
    });

    expect(result).toMatchObject({
      status: "queued-for-compaction",
      traceparent: VALID_TRACEPARENT,
    });
    expect(consumeStagedPostCompactionDelegates("test-session")).toEqual([
      expect.objectContaining({
        task: "carry traced compacted working state forward",
        traceparent: VALID_TRACEPARENT,
      }),
    ]);
  });
});
