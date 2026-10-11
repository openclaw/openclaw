import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createEmbeddedAgentRunnerOpenAiConfig } from "../../agents/test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { toErrorObject } from "../../infra/errors.js";
import { readTranscriptMessages } from "../../sessions/user-turn-transcript.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runCronIsolatedAgentTurn } from "./run.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function successfulResponse(model: string) {
  const item = {
    id: "fallback-message",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Fallback report", annotations: [] }],
  };
  const response = {
    id: "fallback-response",
    model,
    status: "completed",
    output: [item],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    {
      type: "response.content_part.added",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: "Fallback report",
    },
    {
      type: "response.output_text.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text: "Fallback report",
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

it("continues one cron user turn when the primary times out after provider dispatch", async () => {
  await withOpenClawTestState({ label: "cron-fallback-transcript" }, async (state) => {
    await mkdir(state.agentDir(), { recursive: true });
    await writeFile(
      path.join(state.agentDir(), "settings.json"),
      JSON.stringify({ retry: { provider: { maxRetries: 0 } } }),
    );
    const config = createEmbeddedAgentRunnerOpenAiConfig(["primary", "backup"]);
    config.plugins = { enabled: false };
    const models = expectDefined(config.models, "model fixture");
    models.providers = {
      "mock-openai": {
        ...expectDefined(models.providers?.openai, "provider fixture"),
        baseUrl: "http://127.0.0.1:44080/v1",
        timeoutSeconds: 2,
        request: { allowPrivateNetwork: true },
      },
    };
    models.catalogRefresh = { enabled: false };
    config.agents = {
      entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
      defaults: {
        workspace: state.workspaceDir,
        model: { primary: "mock-openai/primary", fallbacks: ["mock-openai/backup"] },
        models: {
          "mock-openai/primary": {
            agentRuntime: { id: "openclaw" },
            params: { transport: "sse", openaiWsWarmup: false },
          },
          "mock-openai/backup": {
            agentRuntime: { id: "openclaw" },
            params: { transport: "sse", openaiWsWarmup: false },
          },
        },
      },
    };
    const requests: string[] = [];
    const timeoutAdvances: ReturnType<typeof vi.advanceTimersByTimeAsync>[] = [];
    const fetchProvider = vi.fn<typeof fetch>(async (_url, options) => {
      const request = new Request(_url, options);
      const body = JSON.parse(await request.text()) as { model: string };
      requests.push(body.model);
      if (body.model !== "primary") {
        return successfulResponse(body.model);
      }
      const { signal } = request;
      return await new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          vi.useRealTimers();
          reject(toErrorObject(signal.reason, "request aborted"));
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
        }
        const advance = vi.advanceTimersByTimeAsync(2_001);
        advance.catch(reject);
        timeoutAdvances.push(advance);
      });
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchProvider);

    const previousConfig = getRuntimeConfigSnapshot();
    setRuntimeConfigSnapshot(config);
    try {
      const running = runCronIsolatedAgentTurn({
        cfg: config,
        onExecutionPhase: ({ phase, model }) => {
          if (phase === "model_call_started" && model === "primary") {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          }
        },
        deps: {},
        deliveryAttemptFence: null,
        agentId: "main",
        sessionKey: "cron:fallback-transcript",
        message: "Reply exactly Fallback report",
        job: {
          id: "fallback-transcript",
          name: "Fallback transcript proof",
          enabled: false,
          createdAtMs: 1,
          updatedAtMs: 1,
          schedule: { kind: "every", everyMs: 3_600_000 },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: {
            kind: "agentTurn",
            message: "Reply exactly Fallback report",
            timeoutSeconds: 120,
            toolsAllow: [],
          },
          delivery: { mode: "none" },
          state: {},
        },
      });

      const result = await running;
      await Promise.all(timeoutAdvances);
      vi.useRealTimers();

      expect(result, JSON.stringify({ result, requests })).toMatchObject({
        status: "ok",
        outputText: "Fallback report",
      });
      expect(requests).toEqual(["primary", "backup"]);
      const messages = await readTranscriptMessages({
        sessionId: result.sessionId!,
        sessionKey: result.sessionKey!,
        storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
      });
      expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
      expect(
        messages.filter((message) => message.role === "assistant" && message.stopReason === "stop"),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      if (previousConfig) {
        setRuntimeConfigSnapshot(previousConfig);
      } else {
        clearRuntimeConfigSnapshot();
      }
    }
  });
});
