import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { onAgentEventForRun, type AgentEventPayload } from "../../infra/agent-events.js";
import {
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
  resetAgentRunRegistryForTest,
  resolveProjectedAgentRunModel,
} from "../../infra/agent-run-registry.js";
import type { AgentRunContext } from "../../infra/agent-run-registry.types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import {
  MODEL,
  PROVIDER,
  SESSION_ID,
  SESSION_KEY,
  finalMessage,
  params,
  request,
  sessionEntry,
  setup,
  type Execution,
} from "./inference-runtime.test-support.js";

const RUN_ID = request().runId;
const REROUTED_MODEL = "fixture-rerouted";
const runContext = {
  sessionId: SESSION_ID,
  sessionKey: SESSION_KEY,
  agentId: "runtime-agent",
  projectSessionActive: true,
} satisfies AgentRunContext;

function projectedModel() {
  return resolveProjectedAgentRunModel({ agentId: "runtime-agent", sessionId: SESSION_ID });
}

async function startInference(context: AgentRunContext = runContext, responseModel?: string) {
  registerAgentRunContext(RUN_ID, context);
  const runtime = setup(sessionEntry);
  const stream = createAssistantMessageEventStream();
  const message = finalMessage();
  message.content = [{ type: "text", text: "Held response" }];
  if (responseModel !== undefined) {
    message.responseModel = responseModel;
  }
  runtime.stream.mockReturnValue(stream);
  const modelEvents: AgentEventPayload[] = [];
  const unsubscribe = onAgentEventForRun(RUN_ID, (event) => {
    if (event.stream === "lifecycle" && event.data.phase === "model") {
      modelEvents.push(event);
    }
  });
  const emit = vi.fn<Execution["emit"]>();
  const abort = new AbortController();
  let current = true;
  const execution = params(request(), emit);
  execution.signal = abort.signal;
  execution.isCurrent = () => current;
  const pending = runtime.executor(execution);
  onTestFinished(async () => {
    stream.end(message);
    await pending;
    unsubscribe();
  });
  stream.push({ type: "start", partial: message });
  if (context === runContext) {
    await vi.waitFor(() => expect(projectedModel()).toEqual({ provider: PROVIDER, model: MODEL }));
  }
  return {
    runtime,
    modelEvents,
    emit,
    abort,
    pending,
    finish: () => {
      stream.push({ type: "done", reason: "stop", message });
      return pending;
    },
    reroute: (delta: string) => {
      message.responseModel = REROUTED_MODEL;
      stream.push({ type: "text_delta", contentIndex: 0, delta });
    },
    revoke: () => {
      current = false;
    },
  };
}

afterEach(() => resetAgentRunRegistryForTest());

it("publishes the configured model, then a responseModel reroute from a lean delta while held", async () => {
  const inference = await startInference();
  inference.reroute("Held response");
  await vi.waitFor(() => expect(inference.emit).toHaveBeenCalledTimes(2));

  expect(projectedModel()).toEqual({ provider: PROVIDER, model: REROUTED_MODEL });
  expect(inference.modelEvents.map((event) => event.data)).toEqual([
    { phase: "model", provider: PROVIDER, model: MODEL },
    { phase: "model", provider: PROVIDER, model: REROUTED_MODEL },
  ]);
  expect(inference.modelEvents).toEqual([
    expect.objectContaining({ runId: RUN_ID, sessionId: SESSION_ID, sessionKey: SESSION_KEY }),
    expect.objectContaining({ runId: RUN_ID, sessionId: SESSION_ID, sessionKey: SESSION_KEY }),
  ]);
  expect(inference.runtime.releaseRuntime).not.toHaveBeenCalled();
  expect(inference.emit).toHaveBeenCalledWith({
    type: "text_delta",
    contentIndex: 0,
    delta: "Held response",
  });

  await expect(inference.finish()).resolves.toMatchObject({
    type: "done",
    message: { model: MODEL, responseModel: REROUTED_MODEL },
  });
  expect(inference.modelEvents).toHaveLength(2);
  expect(projectedModel()).toEqual({ provider: PROVIDER, model: REROUTED_MODEL });
  clearAgentRunContext(RUN_ID);
  expect(projectedModel()).toBeUndefined();
});

it.each([
  { name: "session ID", mismatch: { sessionId: "foreign-session" } },
  { name: "session key", mismatch: { sessionKey: "agent:runtime-agent:foreign" } },
  { name: "agent", mismatch: { agentId: "foreign-agent" } },
])("ignores a run with a different $name", async ({ mismatch }) => {
  const inference = await startInference({ ...runContext, ...mismatch }, REROUTED_MODEL);
  await expect(inference.finish()).resolves.toMatchObject({ type: "done" });
  expect(inference.modelEvents).toEqual([]);
  expect(getAgentRunContext(RUN_ID)?.activeModel).toBeUndefined();
});

it("does not publish a held reroute into a replacement run with the same identifiers", async () => {
  const inference = await startInference();
  const originalContext = getAgentRunContext(RUN_ID);
  clearAgentRunContext(RUN_ID);
  registerAgentRunContext(RUN_ID, runContext);
  inference.reroute("Late response");
  await vi.waitFor(() => expect(inference.emit).toHaveBeenCalledTimes(2));

  expect(getAgentRunContext(RUN_ID)).not.toBe(originalContext);
  expect(projectedModel()).toBeNull();
  expect(inference.modelEvents).toHaveLength(1);
  await expect(inference.finish()).resolves.toMatchObject({ type: "done" });
  expect(projectedModel()).toBeNull();
  expect(inference.modelEvents).toHaveLength(1);
});

it.each(["revocation", "abort"] as const)(
  "stops held reroute publication after %s",
  async (cancellation) => {
    const inference = await startInference();
    if (cancellation === "abort") {
      inference.abort.abort();
    } else {
      inference.revoke();
    }
    inference.reroute("Late response");

    await expect(inference.pending).resolves.toMatchObject({
      type: "error",
      reason: "cancelled",
    });
    expect(inference.modelEvents).toHaveLength(1);
    expect(projectedModel()).toEqual({ provider: PROVIDER, model: MODEL });
    expect(inference.emit.mock.calls.map(([event]) => event.type)).toEqual(["start"]);
    expect(inference.runtime.releaseRuntime).toHaveBeenCalledOnce();
  },
);
