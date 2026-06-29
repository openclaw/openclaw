/**
 * Real behavior proof for #93917 / PR #94050.
 *
 * DUAL SCENARIO: shows failed exec loops now hit the circuit breaker,
 * while completed exec loops with varying output remain at warning.
 */
import { describe, expect, it } from "vitest";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import {
  GLOBAL_CIRCUIT_BREAKER_THRESHOLD,
  detectToolCallLoop,
  recordToolCall,
  recordToolCallOutcome,
} from "./tool-loop-detection.js";

const ENABLED = { enabled: true };

function recordCall(
  state: SessionState,
  toolName: string,
  params: unknown,
  result: unknown,
  index: number,
) {
  const id = `${toolName}-${index}`;
  recordToolCall(state, toolName, params, id);
  recordToolCallOutcome(state, { toolName, toolParams: params, toolCallId: id, result });
}

describe("#93917 real behavior proof", () => {
  it("escalates repeated docker-failure exec calls to the global circuit breaker despite varying error text", () => {
    const state: SessionState = {
      lastActivity: Date.now(),
      state: "processing",
      queueDepth: 0,
    };
    const params = { command: "docker ps" };

    // Simulate 30 consecutive failed "docker ps" calls — each with slightly
    // different error output (timestamp drift, attempt counters, etc.).
    // This mirrors real-world SSH/Docker/connection-refused loops where the
    // failure mode is identical but the error string changes every call.
    for (let i = 0; i < GLOBAL_CIRCUIT_BREAKER_THRESHOLD; i++) {
      recordCall(
        state,
        "exec",
        params,
        {
          content: [
            {
              type: "text",
              text:
                `error during connect: dial unix /var/run/docker.sock: ` +
                `connect: connection refused (attempt ${i})`,
            },
          ],
          details: {
            status: "failed",
            exitCode: 1,
            durationMs: 50 + (i % 7),
            aggregated: "",
          },
        },
        i,
      );
    }

    const result = detectToolCallLoop(state, "exec", params, ENABLED);
    expect(result.stuck).toBe(true);
    if (result.stuck) {
      // After the fix: volatile error output is stripped from the failed hash,
      // so stable {status, exitCode, timedOut} drives the no-progress streak.
      expect(result.level).toBe("critical");
      expect(result.detector).toBe("global_circuit_breaker");
    }
  });

  it("keeps completed exec with varying output at warning (output is real progress)", () => {
    const state: SessionState = {
      lastActivity: Date.now(),
      state: "processing",
      queueDepth: 0,
    };
    const params = { command: "date" };

    // 30 completed exec calls with genuinely varying output — each call
    // returns a different timestamp. This IS real progress and should NOT
    // hit the global circuit breaker.
    for (let i = 0; i < GLOBAL_CIRCUIT_BREAKER_THRESHOLD; i++) {
      recordCall(
        state,
        "exec",
        params,
        {
          content: [
            {
              type: "text",
              text: `Mon Jun ${20 + (i % 7)} 10:${String(i).padStart(2, "0")}:00 UTC 2026`,
            },
          ],
          details: {
            status: "completed",
            exitCode: 0,
            durationMs: 100 + i,
            aggregated: `tick ${i}`,
          },
        },
        i,
      );
    }

    const result = detectToolCallLoop(state, "exec", params, ENABLED);
    expect(result.stuck).toBe(true);
    if (result.stuck) {
      // Completed exec output is intentionally kept in the hash — varying
      // completed output is a real progress signal.
      expect(result.level).toBe("warning");
      expect(result.detector).toBe("generic_repeat");
    }
  });
});
