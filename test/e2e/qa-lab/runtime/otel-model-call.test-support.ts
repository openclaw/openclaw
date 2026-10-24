import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { DiagnosticTraceContext } from "openclaw/plugin-sdk/diagnostic-runtime";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "../../../../src/agents/embedded-agent-runner/run/attempt.model-diagnostic-events.js";
import { makeAgentAssistantMessage } from "../../../../src/agents/test-helpers/agent-message-fixtures.js";

export async function runModelCallAndCaptureTraceparent(params: {
  trace: DiagnosticTraceContext;
  runId: string;
  callId: string;
  provider: string;
  model: string;
}): Promise<string | undefined> {
  let outboundTraceparent: string | undefined;
  const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
    (
      _model: Parameters<StreamFn>[0],
      _context: Parameters<StreamFn>[1],
      options: Parameters<StreamFn>[2],
    ) => {
      outboundTraceparent = options?.headers?.traceparent ?? undefined;
      const stream = createAssistantMessageEventStream();
      stream.end(makeAgentAssistantMessage({ content: [] }));
      return stream;
    },
    {
      runId: params.runId,
      provider: params.provider,
      model: params.model,
      trace: params.trace,
      nextCallId: () => params.callId,
      suppressPluginHooks: true,
    },
  );
  const response = await wrapped({} as never, { messages: [] });
  await response.result();
  return outboundTraceparent;
}
