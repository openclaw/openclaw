import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../logging/diagnostic-session-state.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import { resetAdjustedParamsByToolCallIdForTests } from "./agent-tools.before-tool-call.state.js";
import type { HookContext } from "./agent-tools.before-tool-call.types.js";
import { admitSingleToolCallLoop, admitToolCallBatch } from "./tool-loop-admission.js";
import { recordToolCall, recordToolCallOutcome } from "./tool-loop-detection.js";

const cases = [
  ["generic_repeat", "warning", 10, "Loop warning:"],
  ["generic_repeat", "critical", 20, "Critical generic loop detected:"],
  ["known_poll_no_progress", "warning", 10, "Polling loop warning:"],
  ["known_poll_no_progress", "critical", 20, "Critical polling loop detected:"],
  ["global_circuit_breaker", "critical", 30, "Runaway-loop limit reached:"],
  ["ping_pong", "warning", 10, "Ping-pong loop warning:"],
  ["ping_pong", "critical", 20, "Critical ping-pong loop detected:"],
  ["argument_churn", "warning", 30, "Argument churn warning:"],
] as const;
type LoopCall = [string, Record<string, unknown>, Record<string, unknown>];

function resetDiagnostics(enabled: boolean) {
  resetDiagnosticSessionStateForTest();
  resetDiagnosticEventsForTest();
  resetAdjustedParamsByToolCallIdForTests();
  setDiagnosticsEnabledForProcess(enabled);
}

describe.each(["single", "batch"] as const)("%s admission Incognito logging", (entry) => {
  beforeEach(() => resetDiagnostics(true));
  afterEach(() => resetDiagnostics(false));

  it.each(cases)(
    "keeps %s %s admission at count %i without private formatted output",
    async (detector, level, count, detectorLog) => {
      const capture = createWarnLogCapture("tool-loop-incognito");
      const events: DiagnosticEventPayload[] = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => {
        if (event.type === "tool.loop") {
          events.push(event);
        }
      });
      try {
        for (const incognito of [true, false]) {
          const sessionKey = `agent:main:dashboard:${incognito ? "incognito-" : ""}tool-loop`;
          const ctx = {
            agentId: "main",
            sessionKey,
            sessionId: incognito ? "private-loop-id" : "ordinary-loop-id",
            runId: incognito ? "private-loop-run" : "ordinary-loop-run",
            loopDetection: { enabled: true },
          } satisfies HookContext;
          const state = getDiagnosticSessionState(ctx);
          const repeatedCall = (index: number): LoopCall => {
            if (detector === "known_poll_no_progress") {
              return ["process", { action: "poll", sessionId: "process-1" }, { status: "running" }];
            }
            if (detector === "ping_pong" && index % 2 === 1) {
              return ["list", { dir: "/workspace" }, {}];
            }
            if (detector === "argument_churn") {
              const paths = ["/tmp/a.md", "/tmp/b.md", "/tmp/a.md", "/tmp/a.md", "/tmp/b.md"];
              return [
                "write",
                { path: paths[index % paths.length], content: "same content" },
                { ok: true, changed: false },
              ];
            }
            return ["read", { path: "/tmp/repeated" }, {}];
          };
          const historyCount = detector === "ping_pong" ? count - 1 : count;
          for (let index = 0; index < historyCount; index += 1) {
            const [name, args, details] = repeatedCall(index);
            const toolCallId = `prior-${index}`;
            recordToolCall(state, name, args, toolCallId, { runId: ctx.runId });
            recordToolCallOutcome(state, {
              toolName: name,
              toolParams: args,
              toolCallId,
              result: {
                content: [{ type: "text", text: `${name} unchanged` }],
                details,
              },
              runId: ctx.runId,
            });
          }
          const [name, args] = repeatedCall(historyCount);
          const toolCallId = "candidate";
          let intervention;
          if (entry === "single") {
            intervention = await admitSingleToolCallLoop(
              { toolName: name, params: args, toolCallId },
              ctx,
            );
          } else {
            const admission = await admitToolCallBatch(
              [{ toolCall: { type: "toolCall", id: toolCallId, name, arguments: args }, args }],
              ctx,
            );
            intervention = admission.intervention ?? admission.warnings?.[0];
            admission.commitReadyCalls?.([{ toolCallId, args }]);
          }
          expect(intervention).toMatchObject({
            kind: level === "critical" ? "critical-tool-loop" : "tool-loop-warning",
            toolCallId,
            count,
            ...(level === "critical" ? { detector, reason: expect.any(String) } : {}),
          });
          await waitForDiagnosticEventsDrained();
          expect(events.at(-1)).toMatchObject({
            type: "tool.loop",
            sessionKey,
            sessionId: ctx.sessionId,
            agentId: "main",
            level,
            action: level === "critical" ? "block" : "warn",
            detector,
            count,
          });
          expect(state.toolCallHistory).toHaveLength(
            Math.min(30, historyCount + (entry === "single" && level === "critical" ? 0 : 1)),
          );
          if (entry === "batch" && level === "critical") {
            expect(state.toolCallHistory?.at(-1)).toMatchObject({
              toolCallId,
              outcomeKind: "tool-loop-veto",
            });
          }
          const admissionLog =
            level === "critical" ? `Blocking ${name}` : `Loop warning for ${name}`;
          for (const prefix of [detectorLog, admissionLog]) {
            expect
              .soft(await capture.findText(prefix))
              .toEqual(incognito ? undefined : expect.any(String));
          }
        }
        expect(events).toHaveLength(2);
      } finally {
        unsubscribe();
        capture.cleanup();
      }
    },
  );
});
