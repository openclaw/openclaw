// Tool loop detection tests cover repeated-call hashing, ping-pong detection,
// unknown-tool thresholds, and circuit-breaker escalation.
import { describe, expect, it, vi } from "vitest";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import type { SessionState } from "../logging/diagnostic-session-state.js";

// Recognize a provider-docked send tool by name (only "telegram" here) so the
// volatility strip applies to it without pulling in the channel-plugin registry; the
// real detector is covered by embedded-agent-messaging's own tests.
const isMessagingToolSendActionMock = vi.hoisted(() =>
  vi.fn((toolName: string): boolean => toolName === "telegram"),
);
vi.mock("./embedded-agent-messaging.js", () => ({
  isMessagingToolSendAction: isMessagingToolSendActionMock,
}));
import { reconcileToolCallExecutionParams } from "./tool-loop-call-reconciliation.js";
import {
  detectToolCallLoop,
  recordToolCall,
  recordToolCallOutcome,
} from "./tool-loop-detection.js";
import { TOOL_LOOP_WARNING_THRESHOLD as WARNING_THRESHOLD } from "./tool-loop-thresholds.js";

function recordSuccessfulCall(
  state: SessionState,
  toolName: string,
  params: unknown,
  result: unknown,
  index: number,
): void {
  const toolCallId = `${toolName}-${index}`;
  recordToolCall(state, toolName, params, toolCallId);
  recordToolCallOutcome(state, {
    toolName,
    toolParams: params,
    toolCallId,
    result,
  });
}

const GLOBAL_CIRCUIT_BREAKER_THRESHOLD = 30;

const enabledLoopDetectionConfig: ToolLoopDetectionConfig = { enabled: true };

function createState(): SessionState {
  return {
    lastActivity: Date.now(),
    state: "processing",
    queueDepth: 0,
  };
}

describe("tool-loop-detection changed-write warning", () => {
  it("warns on repeated changed writes to one target without vetoing the next call", () => {
    const state = createState();
    const targetPath = "/tmp/draft.md";

    for (let index = 0; index < WARNING_THRESHOLD; index += 1) {
      const content = `synthetic revision ${index}`;
      recordSuccessfulCall(
        state,
        "write",
        { path: targetPath, content },
        {
          content: [{ type: "text", text: "write complete" }],
          details: {
            changed: true,
            created: index === 0,
            diff: `+${content}`,
            patch: `--- ${targetPath}\n+++ ${targetPath}\n+${content}`,
          },
        },
        index,
      );
    }

    const nextParams = { path: targetPath, content: "synthetic next revision" };
    expect(
      detectToolCallLoop(state, "write", nextParams, enabledLoopDetectionConfig),
    ).toMatchObject({
      stuck: true,
      level: "warning",
      detector: "argument_churn",
      count: WARNING_THRESHOLD,
      livenessSignal: "argument_churn",
    });
    expect(state.toolCallHistory).toHaveLength(WARNING_THRESHOLD);
  });

  it("starts a new changed-write streak after repeating an earlier variant", () => {
    const state = createState();
    const path = "/tmp/draft.md";
    const changedResult = {
      content: [{ type: "text", text: "write complete" }],
      details: { changed: true, created: false },
    };
    for (let index = 0; index < WARNING_THRESHOLD; index += 1) {
      recordSuccessfulCall(
        state,
        "write",
        { path, content: `revision ${index}` },
        changedResult,
        index,
      );
    }
    recordSuccessfulCall(
      state,
      "write",
      { path, content: "revision 0" },
      changedResult,
      WARNING_THRESHOLD,
    );
    expect(state.toolCallHistory?.at(-1)?.outcomeKind).toBe("write-mutation");
    expect(
      detectToolCallLoop(
        state,
        "write",
        { path, content: "next revision" },
        enabledLoopDetectionConfig,
      ),
    ).toEqual({ stuck: false });

    for (let index = 0; index < WARNING_THRESHOLD - 1; index += 1) {
      recordSuccessfulCall(
        state,
        "write",
        { path, content: `new revision ${index}` },
        changedResult,
        WARNING_THRESHOLD + index + 1,
      );
    }
    expect(
      detectToolCallLoop(
        state,
        "write",
        { path, content: "later revision" },
        enabledLoopDetectionConfig,
      ),
    ).toMatchObject({ stuck: true, detector: "argument_churn", count: WARNING_THRESHOLD });
  });

  it("resets changed-write churn after target escape or verification", () => {
    const state = createState();
    const targetPath = "/tmp/draft.md";
    const changedResult = {
      content: [{ type: "text", text: "write complete" }],
      details: { changed: true, created: false },
    };
    for (let index = 0; index < WARNING_THRESHOLD; index += 1) {
      recordSuccessfulCall(
        state,
        "write",
        { path: targetPath, content: `revision ${index}` },
        changedResult,
        index,
      );
    }

    expect(
      detectToolCallLoop(
        state,
        "write",
        { path: "/tmp/other.md", content: "other" },
        enabledLoopDetectionConfig,
      ),
    ).toEqual({ stuck: false });

    recordSuccessfulCall(
      state,
      "read",
      { path: targetPath },
      { content: [{ type: "text", text: "verified" }], details: { ok: true } },
      WARNING_THRESHOLD,
    );
    expect(
      detectToolCallLoop(
        state,
        "write",
        { path: targetPath, content: "verified revision" },
        enabledLoopDetectionConfig,
      ),
    ).toEqual({ stuck: false });
  });

  it("does not treat a repeated body as changed-write argument churn", () => {
    const state = createState();
    const targetPath = "/tmp/draft.md";
    for (let index = 0; index < WARNING_THRESHOLD; index += 1) {
      recordSuccessfulCall(
        state,
        "write",
        { path: targetPath, content: `revision ${index}` },
        {
          content: [{ type: "text", text: "write complete" }],
          details: { changed: true, created: false },
        },
        index,
      );
    }
    expect(
      detectToolCallLoop(
        state,
        "write",
        { path: targetPath, content: "revision 9" },
        enabledLoopDetectionConfig,
      ),
    ).toEqual({ stuck: false });
  });

  it("normalizes built-in write path aliases against the execution cwd", () => {
    const state = createState();
    const scope = { cwd: "/tmp/workspace" };
    const fileUrl = "file:///tmp/workspace/draft.md";
    for (let index = 0; index < WARNING_THRESHOLD; index += 1) {
      const params = {
        path: index % 2 === 0 ? "@draft.md" : fileUrl,
        content: `revision ${index}`,
      };
      const toolCallId = `write-alias-${index}`;
      recordToolCall(state, "write", params, toolCallId, enabledLoopDetectionConfig, scope);
      recordToolCallOutcome(state, {
        toolName: "write",
        toolParams: params,
        toolCallId,
        result: {
          content: [{ type: "text", text: "write complete" }],
          details: { changed: true, created: false },
        },
        config: enabledLoopDetectionConfig,
        cwd: scope.cwd,
      });
    }
    expect(
      detectToolCallLoop(
        state,
        "write",
        { path: "notes/../draft.md", content: "next revision" },
        enabledLoopDetectionConfig,
        scope,
      ),
    ).toMatchObject({
      stuck: true,
      detector: "argument_churn",
      count: WARNING_THRESHOLD,
    });
  });

  it("scopes changed-write warning buckets to the mutation target", () => {
    const warningKeys = ["/tmp/first.md", "/tmp/second.md"].map((targetPath) => {
      const state = createState();
      for (let index = 0; index < WARNING_THRESHOLD; index += 1) {
        recordSuccessfulCall(
          state,
          "write",
          { path: targetPath, content: `revision ${index}` },
          {
            content: [{ type: "text", text: "write complete" }],
            details: { changed: true, created: false },
          },
          index,
        );
      }
      const result = detectToolCallLoop(
        state,
        "write",
        { path: targetPath, content: "next revision" },
        enabledLoopDetectionConfig,
      );
      if (!result.stuck) {
        throw new Error("expected same-target write churn warning");
      }
      expect(result).toMatchObject({ detector: "argument_churn" });
      return result.warningKey;
    });

    expect(warningKeys[0]).toBeTypeOf("string");
    expect(warningKeys[1]).toBeTypeOf("string");
    expect(warningKeys[0]).not.toBe(warningKeys[1]);
  });

  it("keeps whitespace-distinct write targets separate", () => {
    const state = createState();
    const scope = { cwd: "/tmp/workspace" };
    for (let index = 0; index < WARNING_THRESHOLD; index += 1) {
      const params = { path: "draft.md", content: `revision ${index}` };
      const toolCallId = `write-whitespace-${index}`;
      recordToolCall(state, "write", params, toolCallId, enabledLoopDetectionConfig, scope);
      recordToolCallOutcome(state, {
        toolName: "write",
        toolParams: params,
        toolCallId,
        result: {
          content: [{ type: "text", text: "write complete" }],
          details: { changed: true, created: false },
        },
        config: enabledLoopDetectionConfig,
        cwd: scope.cwd,
      });
    }

    expect(
      detectToolCallLoop(
        state,
        "write",
        { path: " draft.md ", content: "separate target" },
        enabledLoopDetectionConfig,
        scope,
      ),
    ).toEqual({ stuck: false });
  });

  it("warns on repeated stable argument churn without vetoing the next call", () => {
    const state = createState();
    const paths = ["/tmp/a.md", "/tmp/b.md", "/tmp/a.md", "/tmp/a.md", "/tmp/b.md"];

    for (let index = 0; index < GLOBAL_CIRCUIT_BREAKER_THRESHOLD; index += 1) {
      const targetPath = paths[index % paths.length]!;
      recordSuccessfulCall(
        state,
        "write",
        { path: targetPath, content: "same content" },
        {
          content: [{ type: "text", text: "write made no changes" }],
          details: { ok: true, changed: false },
        },
        index,
      );
    }

    const loopResult = detectToolCallLoop(
      state,
      "write",
      { path: "/tmp/a.md", content: "same content" },
      enabledLoopDetectionConfig,
    );

    expect(loopResult.stuck).toBe(true);
    if (loopResult.stuck) {
      expect(loopResult.level).toBe("warning");
      expect(loopResult.detector).toBe("argument_churn");
      expect(loopResult.livenessSignal).toBe("argument_churn");
      expect(loopResult.count).toBe(GLOBAL_CIRCUIT_BREAKER_THRESHOLD);
      expect(loopResult.message).toContain("tool call remains allowed");
    }

    const escapeResult = detectToolCallLoop(
      state,
      "write",
      { path: "/tmp/c.md", content: "same content" },
      enabledLoopDetectionConfig,
    );
    expect(escapeResult.stuck).toBe(false);
  });

  it("reports unchanged prepared params without treating them as an escape", () => {
    const state = createState();
    const params = { path: "/tmp/draft.md", content: "same content" };
    recordToolCall(state, "write", params, "prepared-call", undefined, { runId: "run-1" });

    expect(
      reconcileToolCallExecutionParams(state, {
        toolName: "write",
        toolParams: params,
        toolCallId: "prepared-call",
        runId: "run-1",
        warningThreshold: 6,
      }),
    ).toEqual({
      active: false,
      count: 0,
      variantCount: 0,
      matchedPendingCall: true,
      executionParamsChanged: false,
    });
  });
});
