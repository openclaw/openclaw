/**
 * Real foreground exec loop-detection coverage (#93917).
 *
 * Drives the actual exec tool (createOpenClawCodingTools -> execTool.execute)
 * against a command that fails with volatile stderr but identical params, then
 * feeds each real result through the production loop recorders. This validates
 * the runtime contract vincentkoc flagged: a real failed exec result must carry
 * stable failureKind/exitSignal into the outcome hash, so repeated failures
 * whose error text varies still accumulate a no-progress streak and trip the
 * global circuit breaker instead of resetting on every fresh error string.
 *
 * It also covers the canonical case ClawSweeper flagged: an ordinary nonzero
 * exit (grep/SSH/Docker exit 1) is a real `status: "completed"` result, not a
 * shell 126/127 failure. Those must fingerprint by stable exit facts too, while
 * exit-0 output stays a progress signal.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import {
  detectToolCallLoop,
  recordToolCall,
  recordToolCallOutcome,
} from "./tool-loop-detection.js";

const tempDirs = createTempDirTracker();

// Low thresholds keep the real-process loop bounded while still exercising the
// production critical/global breaker path.
const LOOP_CONFIG = {
  enabled: true,
  warningThreshold: 2,
  criticalThreshold: 3,
  globalCircuitBreakerThreshold: 4,
} as const;

function createRealExecTool(prefix: string) {
  const root = tempDirs.make(`${prefix}-`);
  const workspaceDir = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const tools = createOpenClawCodingTools({
    config: { tools: { exec: { security: "full", ask: "off" } } },
    sessionKey: "agent:main:main",
    workspaceDir,
    agentDir,
  });
  const execTool = tools.find((tool) => tool.name === "exec");
  if (!execTool) {
    throw new Error("expected exec tool");
  }
  return execTool;
}

describe("exec foreground failed-result loop detection (#93917)", () => {
  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
  });

  afterEach(() => {
    tempDirs.cleanup();
  });

  it("trips the no-progress breaker on repeated failed exec with volatile stderr", async () => {
    const execTool = createRealExecTool("exec-fg-breaker");
    // Identical params every call; stderr text differs each call (fresh
    // nanoseconds), then a missing binary exits 127 -> a real `status: "failed"`
    // outcome. This is exactly the #93917 "same failure, volatile error text"
    // case: the failed hash must ignore the varying text and still accumulate.
    const params = {
      command: "printf 'attempt %s\\n' \"$(date +%s%N)\" 1>&2; missing-binary-xyz-93917",
    };
    const state: { toolCallHistory?: unknown[] } = {};
    let firstDetails: Record<string, unknown> | undefined;
    let breaker: { detector?: string; level?: string; count?: number } | undefined;

    for (let i = 1; i <= LOOP_CONFIG.globalCircuitBreakerThreshold + 1; i += 1) {
      const callId = `c${i}`;
      const result = await execTool.execute(callId, params);
      if (i === 1) {
        firstDetails = (result as { details?: Record<string, unknown> }).details;
      }
      recordToolCall(state as never, "exec", params, callId, LOOP_CONFIG as never);
      recordToolCallOutcome(state as never, {
        toolName: "exec",
        toolParams: params,
        toolCallId: callId,
        result,
        config: LOOP_CONFIG as never,
      });
      const detect = detectToolCallLoop(state as never, "exec", params, LOOP_CONFIG as never);
      if (detect.stuck && detect.detector === "global_circuit_breaker") {
        breaker = { detector: detect.detector, level: detect.level, count: detect.count };
        break;
      }
    }

    // Real foreground failed exec carries stable discriminators into the hash.
    expect(firstDetails?.status).toBe("failed");
    expect(firstDetails?.failureKind).toBeTruthy();
    expect(firstDetails).toHaveProperty("exitSignal");
    // Varying stderr text still accumulates a no-progress streak to the breaker.
    expect(breaker?.detector).toBe("global_circuit_breaker");
    expect(breaker?.level).toBe("critical");
  });

  it("does not merge distinct real failure modes into one no-progress streak", async () => {
    const execTool = createRealExecTool("exec-fg-distinct");
    // Missing binary -> exit 127 -> "shell-command-not-found";
    // overall timeout -> "overall-timeout". Two distinct real failed outcomes.
    const notFound = (await execTool.execute("nf", {
      command: "missing-binary-xyz-93917",
    })) as { details?: Record<string, unknown> };
    const timedOut = (await execTool.execute("to", {
      command: "sleep 5",
      timeout: 1,
    })) as { details?: Record<string, unknown> };

    expect(notFound.details?.status).toBe("failed");
    expect(timedOut.details?.status).toBe("failed");
    // Different real failure modes must expose different stable discriminators
    // so they cannot collapse into the same no-progress fingerprint.
    expect(timedOut.details?.failureKind).not.toBe(notFound.details?.failureKind);
  });

  it("trips the breaker on repeated nonzero completed exec with volatile output", async () => {
    const execTool = createRealExecTool("exec-fg-nonzero");
    // Ordinary nonzero exit: identical params, fresh stdout each call, then a
    // shell `exit 1`. That is a real `status: "completed"` result (not a shell
    // 126/127 failure) — exactly the grep/SSH/Docker exit-1 retry loop from
    // #93917. The completed hash must ignore the varying output for nonzero
    // exits so the no-progress streak accumulates to the breaker.
    const params = {
      command: "printf 'attempt %s\\n' \"$(date +%s%N)\"; exit 1",
    };
    const state: { toolCallHistory?: unknown[] } = {};
    let firstDetails: Record<string, unknown> | undefined;
    let breaker: { detector?: string; level?: string; count?: number } | undefined;

    for (let i = 1; i <= LOOP_CONFIG.globalCircuitBreakerThreshold + 1; i += 1) {
      const callId = `n${i}`;
      const result = await execTool.execute(callId, params);
      if (i === 1) {
        firstDetails = (result as { details?: Record<string, unknown> }).details;
      }
      recordToolCall(state as never, "exec", params, callId, LOOP_CONFIG as never);
      recordToolCallOutcome(state as never, {
        toolName: "exec",
        toolParams: params,
        toolCallId: callId,
        result,
        config: LOOP_CONFIG as never,
      });
      const detect = detectToolCallLoop(state as never, "exec", params, LOOP_CONFIG as never);
      if (detect.stuck && detect.detector === "global_circuit_breaker") {
        breaker = { detector: detect.detector, level: detect.level, count: detect.count };
        break;
      }
    }

    // A nonzero exit is a real completed outcome, not a shell 126/127 failure.
    expect(firstDetails?.status).toBe("completed");
    expect(firstDetails?.exitCode).toBe(1);
    // Volatile output no longer defeats the streak for nonzero completed exits.
    expect(breaker?.detector).toBe("global_circuit_breaker");
    expect(breaker?.level).toBe("critical");
  });

  it("keeps exit-0 output as a progress signal despite varying text", async () => {
    const execTool = createRealExecTool("exec-fg-progress");
    // A successful exit with fresh output each call is real progress, so the
    // no-progress streak must not accumulate and the breaker must stay silent —
    // the negative control guarding the exit-0 branch of the completed hash.
    const params = {
      command: "printf 'progress %s\\n' \"$(date +%s%N)\"",
    };
    const state: { toolCallHistory?: unknown[] } = {};
    let lastStatus: unknown;
    let breaker: { detector?: string } | undefined;

    for (let i = 1; i <= LOOP_CONFIG.globalCircuitBreakerThreshold + 1; i += 1) {
      const callId = `p${i}`;
      const result = await execTool.execute(callId, params);
      lastStatus = (result as { details?: Record<string, unknown> }).details?.status;
      recordToolCall(state as never, "exec", params, callId, LOOP_CONFIG as never);
      recordToolCallOutcome(state as never, {
        toolName: "exec",
        toolParams: params,
        toolCallId: callId,
        result,
        config: LOOP_CONFIG as never,
      });
      const detect = detectToolCallLoop(state as never, "exec", params, LOOP_CONFIG as never);
      if (detect.stuck && detect.detector === "global_circuit_breaker") {
        breaker = { detector: detect.detector };
        break;
      }
    }

    expect(lastStatus).toBe("completed");
    // exit 0 with changing output stays progress-sensitive: no false breaker.
    expect(breaker).toBeUndefined();
  });

  it("vetoes repeated nonzero completed exec through the real before_tool_call hook", async () => {
    resetDiagnosticSessionStateForTest();
    const execTool = createRealExecTool("exec-fg-hook-nonzero");
    // Drive the production orchestration path a live agent turn runs: the wrapped
    // execute() calls detectToolCallLoop -> real exec child process -> the changed
    // outcome hash, and returns a blocked "tool-loop" veto instead of executing
    // once the no-progress streak reaches critical. Proves the fix reaches the
    // real circuit breaker, not just the detector functions in isolation.
    const ctx = {
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "hook-nonzero",
      runId: "run-hook-nonzero",
      loopDetection: LOOP_CONFIG,
    };
    const wrapped = wrapToolWithBeforeToolCallHook(execTool as never, ctx as never, {
      emitDiagnostics: false,
    });
    const params = { command: "printf 'attempt %s\\n' \"$(date +%s%N)\"; exit 1" };
    let firstStatus: unknown;
    let firstExitCode: unknown;
    let vetoedAtCall: number | undefined;

    for (let i = 1; i <= LOOP_CONFIG.globalCircuitBreakerThreshold + 2; i += 1) {
      const result = (await wrapped.execute(`h${i}`, params, undefined, undefined)) as {
        details?: { status?: unknown; deniedReason?: unknown; exitCode?: unknown };
      };
      if (i === 1) {
        firstStatus = result.details?.status;
        firstExitCode = result.details?.exitCode;
      }
      if (result.details?.deniedReason === "tool-loop") {
        vetoedAtCall = i;
        break;
      }
    }

    // A real nonzero exit is a completed outcome the hook still vetoes on repeat.
    expect(firstStatus).toBe("completed");
    expect(firstExitCode).toBe(1);
    expect(vetoedAtCall).toBeDefined();
  });

  it("keeps exit-0 volatile output unblocked through the real before_tool_call hook", async () => {
    resetDiagnosticSessionStateForTest();
    const execTool = createRealExecTool("exec-fg-hook-progress");
    // Negative control on the same production path: a successful command with
    // fresh output each call is real progress, so the hook must never veto it.
    const ctx = {
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "hook-progress",
      runId: "run-hook-progress",
      loopDetection: LOOP_CONFIG,
    };
    const wrapped = wrapToolWithBeforeToolCallHook(execTool as never, ctx as never, {
      emitDiagnostics: false,
    });
    const params = { command: "printf 'progress %s\\n' \"$(date +%s%N)\"" };
    let vetoed = false;

    for (let i = 1; i <= LOOP_CONFIG.globalCircuitBreakerThreshold + 2; i += 1) {
      const result = (await wrapped.execute(`p${i}`, params, undefined, undefined)) as {
        details?: { deniedReason?: unknown };
      };
      if (result.details?.deniedReason === "tool-loop") {
        vetoed = true;
        break;
      }
    }

    expect(vetoed).toBe(false);
  });
});
