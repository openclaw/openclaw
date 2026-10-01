import { describe, expect, it, vi } from "vitest";
import {
  runFallbackModelAttempt,
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import {
  SKILL_WORKSHOP_MAINTENANCE_PROMPT,
  SKILL_WORKSHOP_MAINTENANCE_TOOLS,
} from "../../skills/workshop/maintenance-prompt.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  patchSessionEntryMock,
  resolveAgentConfigMock,
  resolveConfiguredModelRefMock,
  resolveEffectiveAgentRuntimeMock,
  resolveAgentModelFallbacksOverrideMock,
  runCliAgentMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
  pickLastNonEmptyTextFromPayloadsMock,
  resolveCronPayloadOutcomeMock,
} from "./run.test-harness.js";

// Payload fallback tests cover fallback prompt payloads for isolated cron runs.

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function requireModelFallbackRequest(): {
  fallbacksOverride?: string[];
  provider?: string;
  model?: string;
} {
  const request = runWithModelFallbackMock.mock.calls[0]?.[0] as
    | {
        fallbacksOverride?: string[];
        provider?: string;
        model?: string;
      }
    | undefined;
  if (!request) {
    throw new Error("Expected model fallback request");
  }
  return request;
}
describe("runCronIsolatedAgentTurn — payload.fallbacks", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  it("uses the persisted agentTurn payload message when the dispatch message is malformed", async () => {
    mockRunCronFallbackPassthrough();
    const dispatchMessage = "SERIALIZATION_PROBE should not be wrapped";

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          payload: {
            kind: "agentTurn",
            message:
              "SERIALIZATION_PROBE: reply exactly with the marker token you received and nothing else.",
          },
        }),
        message: { message: dispatchMessage } as unknown as string,
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    const request = runEmbeddedAgentMock.mock.calls[0]?.[0] as { prompt?: unknown } | undefined;
    expect(request?.prompt).toContain("SERIALIZATION_PROBE: reply exactly");
    expect(request?.prompt).not.toContain(dispatchMessage);
    expect(request?.prompt).not.toContain("[object Object]");
  });

  it("payload.fallbacks=[] disables configured agent fallbacks", async () => {
    resolveAgentModelFallbacksOverrideMock.mockReturnValue(["openai/gpt-4o"]);
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          payload: { kind: "agentTurn", message: "test", fallbacks: [] },
        }),
      }),
    );
    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    expect(requireModelFallbackRequest().fallbacksOverride).toEqual([]);
  });

  it("keeps pre-envelope app-less default caps free of recovery prompt changes", async () => {
    mockRunCronFallbackPassthrough();
    resolveEffectiveAgentRuntimeMock.mockReturnValue("codex");

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          toolsAllowProvenance: { version: 1, source: "final-executable-surface" },
          payload: {
            kind: "agentTurn",
            message: "use calendar",
            toolsAllow: ["read", "cron"],
            toolsAllowIsDefault: true,
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledRuntimeAuthorityRecoveryRequired: false }),
    );
  });

  it("forwards reauthorization recovery after an explicit tools cap clears app authority", async () => {
    mockRunCronFallbackPassthrough();
    resolveEffectiveAgentRuntimeMock.mockReturnValue("codex");

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          runtimeAuthorityRecoveryRequired: true,
          payload: { kind: "agentTurn", message: "use calendar", toolsAllow: ["read"] },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledRuntimeAuthorityRecoveryRequired: true }),
    );
  });

  it("plans Anthropic fallbacks canonically while executing compatible attempts through Claude CLI", async () => {
    isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    runCliAgentMock.mockImplementation(async (request) => {
      request.userTurnTranscriptRecorder?.markBlocked();
      return {
        payloads: [{ text: "fallback ok" }],
        meta: { agentMeta: {} },
      };
    });
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => {
      const firstResult = await runInitialModelFallbackAttempt(params);
      const secondResult = await runFallbackModelAttempt(
        params,
        "anthropic",
        "claude-sonnet-4-6",
        "unknown",
      );
      return {
        result: secondResult ?? firstResult,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        attempts: [],
      };
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "anthropic/claude-opus-4-6",
                fallbacks: ["anthropic/claude-sonnet-4-6"],
              },
              models: {
                "anthropic/claude-opus-4-6": { agentRuntime: { id: "claude-cli" } },
                "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
              },
            },
          },
        },
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
    const fallbackRequest = requireModelFallbackRequest();
    expect(fallbackRequest.provider).toBe("anthropic");
    expect(fallbackRequest.model).toBe("claude-opus-4-6");
    expect(
      runCliAgentMock.mock.calls.map((call) => [
        call[0].provider,
        call[0].modelProvider,
        call[0].model,
      ]),
    ).toEqual([
      ["claude-cli", "anthropic", "claude-opus-4-6"],
      ["claude-cli", "anthropic", "claude-sonnet-4-6"],
    ]);
    const firstCliRequest = runCliAgentMock.mock.calls[0]?.[0];
    const secondCliRequest = runCliAgentMock.mock.calls[1]?.[0];
    expect(firstCliRequest?.userTurnTranscriptRecorder).toBeDefined();
    expect(secondCliRequest?.userTurnTranscriptRecorder).toBe(
      firstCliRequest?.userTurnTranscriptRecorder,
    );
    expect(firstCliRequest?.suppressNextUserMessagePersistence).toBe(false);
    expect(secondCliRequest?.suppressNextUserMessagePersistence).toBe(true);
  });

  it.each([
    { name: "a different embedded runtime", runtime: "openclaw", cli: false },
    { name: "a CLI execution path", runtime: "codex", cli: true },
  ])("fails closed before executing stored Codex authority on $name", async ({ runtime, cli }) => {
    mockRunCronFallbackPassthrough();
    resolveEffectiveAgentRuntimeMock.mockReturnValue(runtime);
    isCliProviderMock.mockReturnValue(cli);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          runtimeAuthority: {
            version: 1,
            runtimeId: "codex",
            namespace: "codex.apps",
            payload: { version: 1 },
          },
        }),
      }),
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("authority captured for the codex runtime");
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(runCliAgentMock).not.toHaveBeenCalled();
  });

  it("does not persist an authority-incompatible fallback on the run continuation", async () => {
    resolveEffectiveAgentRuntimeMock.mockImplementation(({ provider }: { provider: string }) =>
      provider === "openai" ? "codex" : "openclaw",
    );
    runEmbeddedAgentMock.mockRejectedValueOnce(new Error("primary failed"));
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => {
      await expect(runInitialModelFallbackAttempt(params)).rejects.toThrow("primary failed");
      return await runFallbackModelAttempt(params, "anthropic", "claude-sonnet-4-6", "unknown");
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          runtimeAuthority: {
            version: 1,
            runtimeId: "codex",
            namespace: "codex.apps",
            payload: { version: 1 },
          },
        }),
      }),
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("authority captured for the codex runtime");
    const persistedRunRows = await Promise.all(
      patchSessionEntryMock.mock.calls.flatMap((call, index) => {
        const scope = call[0] as { sessionKey?: string };
        const callResult = patchSessionEntryMock.mock.results[index];
        return scope.sessionKey?.includes(":run:") && callResult?.type === "return"
          ? [callResult.value]
          : [];
      }),
    );
    expect(persistedRunRows).not.toHaveLength(0);
    for (const persistedRunRow of persistedRunRows) {
      expect(persistedRunRow).toEqual(
        expect.objectContaining({ modelProvider: "openai", model: "gpt-5.4" }),
      );
    }
  });

  it("uses default subagent fallbacks ahead of a named agent's primary through the run path", async () => {
    mockRunCronFallbackPassthrough();
    resolveAgentConfigMock.mockReturnValue({
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["openai/gpt-5.4"],
      },
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        agentId: "research",
        cfg: {
          agents: {
            defaults: {
              subagents: {
                model: {
                  primary: "kimi/kimi-code",
                  fallbacks: ["openai/gpt-5.2", "zai/glm-5"],
                },
              },
            },
            list: [
              {
                id: "research",
                model: {
                  primary: "anthropic/claude-opus-4-6",
                  fallbacks: ["openai/gpt-5.4"],
                },
              },
            ],
          },
        },
      }),
    );

    expect(result.status).toBe("ok");
    expect(requireModelFallbackRequest().fallbacksOverride).toEqual([
      "openai/gpt-5.2",
      "zai/glm-5",
    ]);
    expect(runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject({
      modelFallbacksOverride: ["openai/gpt-5.2", "zai/glm-5"],
    });
  });
});

// Rooted cron reviews preserve their host-selected root and instructions across runtimes.

const executionRoot = "/tmp/workshop-skills";

describe("runCronIsolatedAgentTurn — rooted runtime fallback", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("rejects a rooted turn before an unsupported harness starts", async () => {
    resolveEffectiveAgentRuntimeMock.mockReturnValue("unsupported-harness");
    mockRunCronFallbackPassthrough();

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({ executionRoot }),
    );

    expect(result).toMatchObject({
      status: "error",
      admissionDisposition: "rejected",
    });
    expect(runCliAgentMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("preserves rooted host constraints when dispatching a Codex review", async () => {
    const skillsSnapshot = { prompt: "Explicit safe instructions", skills: [{ name: "safe" }] };
    resolveEffectiveAgentRuntimeMock.mockReturnValue("codex");
    isCliProviderMock.mockReturnValue(false);
    mockRunCronFallbackPassthrough();

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        executionRoot,
        skillsSnapshot,
        job: {
          payload: {
            kind: "agentTurn",
            message: SKILL_WORKSHOP_MAINTENANCE_PROMPT,
            toolsAllow: [...SKILL_WORKSHOP_MAINTENANCE_TOOLS],
          },
          delivery: { mode: "none" },
        },
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: executionRoot,
        cwd: executionRoot,
        sessionRoot: executionRoot,
        requireWorkspaceOnly: true,
        requireWritableSandbox: true,
        skillsSnapshot,
        toolsAllow: [...SKILL_WORKSHOP_MAINTENANCE_TOOLS],
        trigger: "cron",
      }),
    );
    expect(runCliAgentMock).not.toHaveBeenCalled();
  });

  it("runs a rooted review with a Claude CLI primary and returns its report", async () => {
    const helpers = await vi.importActual<typeof import("./helpers.js")>("./helpers.js");
    pickLastNonEmptyTextFromPayloadsMock.mockImplementation(
      helpers.pickLastNonEmptyTextFromPayloads,
    );
    resolveCronPayloadOutcomeMock.mockImplementation(helpers.resolveCronPayloadOutcome);
    const skillsSnapshot = { prompt: "", skills: [] };
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    resolveEffectiveAgentRuntimeMock.mockReturnValue("claude-cli");
    isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
    runCliAgentMock.mockImplementation(async (params) => {
      params.onExecutionStarted?.();
      return {
        payloads: [{ text: "Workshop review complete: retained useful procedures." }],
        meta: { agentMeta: {} },
      };
    });
    mockRunCronFallbackPassthrough();
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        executionRoot,
        skillsSnapshot,
        job: {
          payload: {
            kind: "agentTurn",
            message: SKILL_WORKSHOP_MAINTENANCE_PROMPT,
            toolsAllow: [...SKILL_WORKSHOP_MAINTENANCE_TOOLS],
          },
          delivery: { mode: "none" },
        },
        cfg: {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-6",
              models: { "anthropic/claude-opus-4-6": { agentRuntime: { id: "claude-cli" } } },
            },
          },
        },
      }),
    );
    expect(result).toMatchObject({
      status: "ok",
      outputText: "Workshop review complete: retained useful procedures.",
    });
    expect(runCliAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "claude-cli",
        rootedExecution: { root: executionRoot },
        workspaceDir: executionRoot,
        skillsSnapshot,
        trigger: "cron",
        toolsAllow: [...SKILL_WORKSHOP_MAINTENANCE_TOOLS],
      }),
    );
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("keeps the rooted instruction snapshot while skipping an unsupported fallback", async () => {
    const onExecutionStarted = vi.fn();
    const onExecutionPhase = vi.fn();
    const skillsSnapshot = { prompt: "Explicit safe instructions", skills: [{ name: "safe" }] };
    resolveEffectiveAgentRuntimeMock.mockImplementation(({ modelId }: { modelId: string }) =>
      modelId === "gpt-5.4" || modelId === "gpt-5" ? "openclaw" : "unsupported-harness",
    );
    isCliProviderMock.mockReturnValue(false);
    runEmbeddedAgentMock.mockImplementation(
      async (params: {
        model?: string;
        onExecutionStarted?: () => void;
        onExecutionPhase?: (info: { phase: "runtime_plugins" }) => void;
      }) => {
        params.onExecutionStarted?.();
        params.onExecutionPhase?.({ phase: "runtime_plugins" });
        if (params.model === "gpt-5.4") {
          throw new Error("embedded primary failed");
        }
        return { payloads: [{ text: "later embedded succeeded" }], meta: { agentMeta: {} } };
      },
    );
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => {
      await expect(runInitialModelFallbackAttempt(params)).rejects.toThrow(
        "embedded primary failed",
      );
      await expect(
        runFallbackModelAttempt(params, "claude-cli", "claude-opus-4-6", "unknown"),
      ).rejects.toThrow("collection review requires a runtime that enforces the Workshop root");
      const result = await runFallbackModelAttempt(params, "openai", "gpt-5", "unknown");
      return { result, provider: "openai", model: "gpt-5", attempts: [] };
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        executionRoot,
        skillsSnapshot,
        onExecutionStarted,
        onExecutionPhase,
      }),
    );

    expect(result.status).toBe("ok");
    expect(onExecutionStarted).toHaveBeenCalledTimes(2);
    expect(onExecutionStarted.mock.calls.map(([info]) => info)).toEqual([
      expect.objectContaining({ provider: "openai", model: "gpt-5.4" }),
      expect.objectContaining({ provider: "openai", model: "gpt-5", isFallback: true }),
    ]);
    expect(onExecutionPhase.mock.calls.map(([info]) => info)).toEqual([
      expect.objectContaining({ provider: "openai", model: "gpt-5.4" }),
      expect.objectContaining({ provider: "openai", model: "gpt-5" }),
    ]);
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expect(runCliAgentMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ provider: "openai", model: "gpt-5", skillsSnapshot }),
    );
  });
});
