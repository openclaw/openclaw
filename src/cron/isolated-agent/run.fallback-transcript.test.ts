import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createDueIsolatedJob } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { persistAuthProfileBatch } from "../../agents/auth-profiles/upsert-with-lock.js";
import { providerResponse } from "../../agents/embedded-agent-runner.wire.test-support.js";
import { createEmbeddedAgentRunnerOpenAiConfig } from "../../agents/test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { AgentModelEntryConfig } from "../../config/types.agent-defaults.js";
import { toErrorObject } from "../../infra/errors.js";
import { readTranscriptMessages } from "../../sessions/user-turn-transcript.test-support.js";
import { readModelFallbackNotice } from "../../shared/model-fallback-notice.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureCronInferenceBinding } from "../inference-binding.runtime.js";
import { runCronIsolatedAgentTurn } from "./run.js";
// Keep lazy runner imports outside the turn's timeout budget.
import "./run-executor.runtime.js";
import "./run-embedded.runtime.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("continues one cron user turn when the primary times out after provider dispatch", () =>
  withOpenClawTestState({ label: "cron-fallback-transcript" }, async (state) => {
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
        apiKey: undefined,
        baseUrl: "http://127.0.0.1:44080/v1",
        timeoutSeconds: 2,
        request: { allowPrivateNetwork: true },
      },
    };
    models.catalogRefresh = { enabled: false };
    config.auth = {
      profiles: { "mock-openai:cron-fixture": { provider: "mock-openai", mode: "api_key" } },
      order: { "mock-openai": ["mock-openai:cron-fixture"] },
    };
    const modelConfig = (): AgentModelEntryConfig => ({
      agentRuntime: { id: "openclaw" },
      params: { transport: "sse", openaiWsWarmup: false },
    });
    config.agents = {
      entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
      defaults: {
        workspace: state.workspaceDir,
        model: { primary: "mock-openai/primary", fallbacks: ["mock-openai/backup"] },
        models: { "mock-openai/primary": modelConfig(), "mock-openai/backup": modelConfig() },
      },
    };
    setRuntimeConfigSnapshot(config);
    await persistAuthProfileBatch({
      stateDir: state.stateDir,
      profiles: [
        {
          profileId: "mock-openai:cron-fixture",
          credential: { type: "api_key", provider: "mock-openai", key: "synthetic-cron-key" },
        },
      ],
    });
    const inferenceBinding = expectDefined(
      await captureCronInferenceBinding({ cfg: config, agentId: "main" }),
      "stored inference account",
    );
    const requests: string[] = [];
    const timeoutAdvances: ReturnType<typeof vi.advanceTimersByTimeAsync>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
      const request = new Request(_url, options);
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-cron-key");
      const body = JSON.parse(await request.text()) as { model: string };
      requests.push(body.model);
      if (body.model !== "primary") {
        return providerResponse({
          api: "openai-responses",
          model: body.model,
          id: "fallback-response",
          messageId: "fallback-message",
          text: "Fallback report",
          calls: [],
        }).response;
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
    const message = "Reply exactly Fallback report";
    const result = await runCronIsolatedAgentTurn({
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
      message,
      job: {
        ...createDueIsolatedJob({ id: "fallback-transcript", nowMs: 1, nextRunAtMs: 1 }),
        inferenceBinding,
        name: "Fallback transcript proof",
        enabled: false,
        schedule: { kind: "every", everyMs: 3_600_000 },
        wakeMode: "now",
        payload: { kind: "agentTurn", message, timeoutSeconds: 120, toolsAllow: [] },
        state: {},
      },
    });

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
    const userMessages = messages.filter((entry) => entry.role === "user");
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]).not.toHaveProperty("display", false);
    expect(userMessages[1]).toMatchObject({
      display: false,
      provenance: { kind: "internal_system" },
    });
    expect(messages.map(readModelFallbackNotice).filter(Boolean)).toMatchObject([
      {
        kind: "model-fallback",
        fromModel: "mock-openai/primary",
        toModel: "mock-openai/backup",
        reason: "timeout",
      },
    ]);
    expect(
      messages.filter(
        (entry) =>
          entry.role === "assistant" &&
          entry.stopReason === "stop" &&
          !readModelFallbackNotice(entry),
      ),
    ).toHaveLength(1);
  }));
