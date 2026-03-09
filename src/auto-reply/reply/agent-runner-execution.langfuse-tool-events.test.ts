import { afterEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { clearRunToolSpans } from "../../observability/langfuse-agent-hooks.js";
import { withLangfuseRequestScope } from "../../observability/langfuse-request-scope.js";
import type { LangfuseHandle } from "../../observability/langfuse.js";
import { subscribeLangfuseToolLifecycle } from "./agent-runner-execution.js";

describe("agent-runner-execution Langfuse tool lifecycle bridge", () => {
  afterEach(() => {
    clearRunToolSpans("run-langfuse");
  });

  it("uses full agent events for Langfuse spans while ignoring incomplete UI callbacks", () => {
    const spanEnd = vi.fn();
    const spanCaptureError = vi.fn();
    const traceSpan = vi.fn(
      () =>
        ({
          enabled: true,
          kind: "span",
          update: vi.fn(),
          end: spanEnd,
          captureError: spanCaptureError,
          span: vi.fn(),
          generation: vi.fn(),
        }) satisfies LangfuseHandle,
    );
    const trace = {
      enabled: true,
      kind: "trace",
      update: vi.fn(),
      end: vi.fn(),
      captureError: vi.fn(),
      span: traceSpan,
      generation: vi.fn(),
    } satisfies LangfuseHandle;

    withLangfuseRequestScope(
      {
        trace,
        requestName: "inbound.request",
      },
      () => {
        const stop = subscribeLangfuseToolLifecycle("run-langfuse");
        try {
          emitAgentEvent({
            runId: "run-langfuse",
            stream: "tool",
            data: {
              phase: "start",
              name: "sessions_spawn",
              toolCallId: "tool-1",
            },
          });
          emitAgentEvent({
            runId: "run-langfuse",
            stream: "tool",
            data: {
              phase: "start",
              name: "sessions_spawn",
              toolCallId: "tool-1",
              args: { task: "investigate" },
            },
          });
          emitAgentEvent({
            runId: "run-langfuse",
            stream: "tool",
            data: {
              phase: "result",
              name: "sessions_spawn",
              toolCallId: "tool-1",
              isError: true,
            },
          });
          emitAgentEvent({
            runId: "run-langfuse",
            stream: "tool",
            data: {
              phase: "result",
              name: "sessions_spawn",
              toolCallId: "tool-1",
              isError: false,
              result: { status: "accepted", runId: "child-1" },
            },
          });
        } finally {
          stop();
        }
      },
    );

    expect(traceSpan).toHaveBeenCalledTimes(1);
    expect(traceSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "tool.sessions_spawn",
        input: { task: "investigate" },
      }),
    );
    expect(spanCaptureError).not.toHaveBeenCalled();
    expect(spanEnd).toHaveBeenCalledTimes(1);
    expect(spanEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        output: { status: "accepted", runId: "child-1" },
      }),
    );
  });
});
