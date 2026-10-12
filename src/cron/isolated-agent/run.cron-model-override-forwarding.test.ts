import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, afterEach } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { classifyEmbeddedAgentRunResultForModelFallback } from "../../agents/embedded-agent-runner/result-fallback-classifier.js";
import {
  abortEmbeddedAgentRun,
  isEmbeddedAgentRunHandleActive,
} from "../../agents/embedded-agent-runner/runs.js";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import {
  runFallbackModelAttempt,
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import type { CliSessionReseedReceipt, CliSessionBinding } from "../../config/sessions.js";
import type { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import type { RunCronAgentTurnParams } from "./run-prepare-runtime.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  ensureAgentWorkspaceMock,
  getCliSessionBindingMock,
  isCliProviderMock,
  isThinkingLevelSupportedMock,
  loadModelCatalogMock,
  loadModelCatalogOwnerMock,
  loadRunCronIsolatedAgentTurn,
  loadSessionEntryMock,
  logWarnMock,
  makeCronSession,
  makeCronSessionEntry,
  mockRunCronFallbackPassthrough,
  patchSessionEntryMock,
  resolveAgentConfigMock,
  resolveAgentModelFallbacksOverrideMock,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  resolveCronSessionMock,
  resolveEffectiveAgentRuntimeMock,
  resolveSessionAuthSelectionMock,
  resolveSupportedThinkingLevelMock,
  resolveThinkingDefaultMock,
  runCliAgentMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
  clearFastTestEnv,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function setupModelSuite() {
  setupRunCronIsolatedAgentTurnSuite();
  beforeEach(() => {
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
  });
}

function makeJob(overrides?: Record<string, unknown>) {
  return makeIsolatedAgentJobFixture({
    id: "model-fwd-job",
    payload: { kind: "agentTurn", message: "summarize", model: "google/gemini-2.0-flash" },
    ...overrides,
  });
}

function makeParams(overrides?: Record<string, unknown>) {
  return makeIsolatedAgentParamsFixture({
    job: makeJob(),
    sessionKey: "cron:model-fwd",
    ...overrides,
  });
}

function makeSuccessfulRunResult(provider = "google", model = "gemini-2.0-flash") {
  return {
    result: {
      result: {
        payloads: [{ text: "summary done" }],
        meta: {
          agentMeta: {
            model,
            provider,
            usage: { input: 100, output: 50 },
          },
        },
      },
    },
    provider,
    model,
    attempts: [],
  };
}

function makeJobWithoutModel(overrides?: Record<string, unknown>) {
  return makeJob({
    payload: { kind: "agentTurn", message: "summarize" },
    ...overrides,
  });
}

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function firstMockArg(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  return requireRecord(mock.mock.calls[0]?.[0]);
}

describe("runCronIsolatedAgentTurn — cron model override forwarding (#58065)", () => {
  setupModelSuite();

  beforeEach(() => {
    resolveAllowedModelRefMock.mockImplementation(({ raw }: { raw: string }) => {
      if (raw.includes("gemini")) {
        return { ref: { provider: "google", model: "gemini-2.0-flash" } };
      }
      return { ref: { provider: "anthropic", model: "claude-opus-4-6" } };
    });
  });

  it("builds cron context from the published replacement owner", async () => {
    const callerConfig = { agents: { defaults: { model: "anthropic/caller" } } };
    const ownerConfig = {
      agents: {
        defaults: { model: "google/gemini-2.0-flash" },
        entries: { main: { workspace: "/tmp/replacement-workspace" } },
      },
    };
    const ownerCatalog = [{ provider: "google", id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" }];
    loadModelCatalogOwnerMock.mockResolvedValueOnce({
      agentId: "main",
      agentDir: "/tmp/owner-agent",
      workspaceDir: "/tmp/replacement-workspace",
      config: ownerConfig,
      modelCatalog: { entries: ownerCatalog, routeVariants: [] },
    });
    ensureAgentWorkspaceMock.mockImplementationOnce(async ({ dir }: { dir: string }) => ({ dir }));
    runWithModelFallbackMock.mockResolvedValueOnce(makeSuccessfulRunResult());

    const result = await runCronIsolatedAgentTurn(makeParams({ cfg: callerConfig }));

    expect(result.status).toBe("ok");
    expect(loadModelCatalogOwnerMock).toHaveBeenCalledWith({
      config: callerConfig,
      readOnly: true,
      allowGatewaySubagentBinding: true,
    });
    expect(ensureAgentWorkspaceMock).toHaveBeenCalledWith(
      expect.objectContaining({ dir: "/tmp/replacement-workspace" }),
    );
    expect(resolveCronSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: ownerConfig, agentId: "main" }),
    );
  });

  it("rejects a replacement owner that changes an explicitly requested agent", async () => {
    const callerConfig = {
      agents: { entries: { main: {}, worker: {} } },
    };
    loadModelCatalogOwnerMock.mockResolvedValueOnce({
      agentId: "main",
      agentDir: "/tmp/main-agent",
      workspaceDir: "/tmp/main-workspace",
      config: callerConfig,
      modelCatalog: { entries: [], routeVariants: [] },
    });

    await expect(
      runCronIsolatedAgentTurn(makeParams({ cfg: callerConfig, agentId: "worker" })),
    ).rejects.toThrow("cron model catalog owner changed from worker to main");
    expect(runWithModelFallbackMock).not.toHaveBeenCalled();
  });

  it("does not mark CLI cron runs as model-started before CLI session resolution", async () => {
    isCliProviderMock.mockReturnValue(true);
    mockRunCronFallbackPassthrough();
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: makeCronSessionEntry({
          model: undefined,
          modelProvider: undefined,
        }),
        isNewSession: false,
      }),
    );
    const getCliSessionStarted = createDeferred();
    const releaseCliSessionLookup = createDeferred<
      { sessionId: string; reseedReceipt: CliSessionReseedReceipt } | undefined
    >();
    getCliSessionBindingMock.mockImplementation(async () => {
      getCliSessionStarted.resolve();
      return await releaseCliSessionLookup.promise;
    });
    runCliAgentMock.mockImplementation(async ({ onExecutionPhase }) => {
      onExecutionPhase?.({
        phase: "model_call_started",
        provider: "google",
        model: "gemini-2.0-flash",
      });
      return {
        payloads: [{ text: "summary done" }],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      };
    });
    const phases: unknown[] = [];

    const runPromise = runCronIsolatedAgentTurn(
      makeParams({
        sessionKey: "existing-cron-session",
        job: makeJob({ sessionTarget: "session:existing-cron-session" }),
        onExecutionPhase: (info: unknown) => phases.push(info),
      }),
    );

    await getCliSessionStarted.promise;
    expect(phases).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "model_call_started",
        }),
      ]),
    );

    const cliSessionBinding = {
      sessionId: "previous-cli-session",
      reseedReceipt: {
        version: 1 as const,
        promptHash: "a".repeat(64),
        localSessionId: "openclaw-session",
        userTurnDisposition: "persisted" as const,
      },
    };
    releaseCliSessionLookup.resolve(cliSessionBinding);
    const result = await runPromise;

    expect(result.status).toBe("ok");
    const cliCall = firstMockArg(runCliAgentMock);
    expect(cliCall.cliSessionId).toBe("previous-cli-session");
    expect(cliCall.cliSessionBinding).toEqual(cliSessionBinding);
    expect(typeof cliCall.onExecutionPhase).toBe("function");
    expect(phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "model_call_started",
        }),
      ]),
    );
  });

  it("does not replay accepted CLI work when continuity saving fails", async () => {
    isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
    resolveAllowedModelRefMock.mockReturnValue({
      ref: { provider: "claude-cli", model: "claude-opus-4-6" },
    });
    mockRunCronFallbackPassthrough();
    const cronSession = makeCronSession({
      sessionEntry: makeCronSessionEntry({
        cliSessionBindings: { "claude-cli": { sessionId: "previous-cli-session" } },
      }),
      isNewSession: false,
    });
    resolveCronSessionMock.mockReturnValue(cronSession);
    const localSessionId = cronSession.sessionEntry.sessionId;
    const cliSessionBinding = {
      sessionId: "fresh-cli-session",
      reseedReceipt: {
        version: 1 as const,
        promptHash: "a".repeat(64),
        localSessionId: cronSession.sessionEntry.sessionId,
        userTurnDisposition: "persisted",
      },
    };
    const candidateResult = {
      payloads: [{ text: "summary done" }],
      meta: {
        durationMs: 1,
        executionTrace: { runner: "cli" },
        agentMeta: {
          provider: "claude-cli",
          model: "claude-opus-4-6",
          sessionId: "fresh-cli-session",
          cliSessionBinding,
          usage: { input: 10, output: 20 },
        },
      },
    };
    runCliAgentMock.mockImplementationOnce(async () => {
      patchSessionEntryMock.mockRejectedValueOnce(new Error("synthetic continuity write failed"));
      return candidateResult;
    });
    let inspectedCandidate: unknown;
    let inspectedClassification: unknown;
    runWithModelFallbackMock.mockImplementationOnce(
      async (
        params: TestModelFallbackRunnerParams & {
          classifyResult: typeof classifyEmbeddedAgentRunResultForModelFallback;
        },
      ) => {
        const first = await runInitialModelFallbackAttempt(params);
        inspectedCandidate = first;
        inspectedClassification = params.classifyResult({
          result: first,
          provider: params.provider,
          model: params.model,
        });
        return { result: first, provider: params.provider, model: params.model, attempts: [] };
      },
    );

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        sessionKey: "existing-cron-session",
        job: makeJob({ sessionTarget: "session:existing-cron-session" }),
      }),
    );

    expect(result.status).toBe("error");
    expect(inspectedCandidate).toMatchObject({
      result: {
        payloads: expect.arrayContaining(candidateResult.payloads ?? []),
        meta: {
          replayInvalid: true,
          agentMeta: { usage: { input: 10, output: 20 } },
          error: {
            message: expect.stringContaining("CLI session continuity could not be saved"),
            fallbackSafe: false,
          },
        },
      },
    });
    expect(inspectedClassification).toBeNull();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(runCliAgentMock).toHaveBeenCalledOnce();
    expect(cronSession.sessionEntry.sessionId).toBe(localSessionId);
    expect(cronSession.sessionEntry.cliSessionBindings?.["claude-cli"]).toEqual({
      sessionId: "previous-cli-session",
    });
  });

  it("restores the requested thinking level when a later fallback supports it", async () => {
    resolveAllowedModelRefMock.mockImplementation(({ raw }: { raw: string }) => {
      const [provider, model] = raw.split("/");
      return { ref: { provider, model } };
    });
    resolveEffectiveAgentRuntimeMock.mockReturnValue("codex");
    isThinkingLevelSupportedMock.mockImplementation(
      ({ model, level }: { model?: string; level?: string }) =>
        model === "gpt-5.6-sol" || level !== "ultra",
    );
    resolveSupportedThinkingLevelMock.mockImplementation(
      ({ model, level }: { model?: string; level?: string }) =>
        model === "gpt-5.6-luna" && level === "ultra" ? "max" : level,
    );
    loadModelCatalogMock.mockResolvedValue([
      { provider: "openai", id: "gpt-5.6-luna", reasoning: true },
      { provider: "openai", id: "gpt-5.6-sol", reasoning: true },
    ]);
    const cronSession = makeCronSession({
      sessionEntry: makeCronSessionEntry({
        thinkingLevel: "ultra",
        agentRuntimeOverride: "codex",
      }),
      isNewSession: true,
    });
    resolveCronSessionMock.mockReturnValue(cronSession);
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => {
      await runInitialModelFallbackAttempt(params);
      const result = await runFallbackModelAttempt(params, "openai", "gpt-5.6-sol", "unknown");
      return {
        result,
        provider: "openai",
        model: "gpt-5.6-sol",
        attempts: [],
      };
    });

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        cfg: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } },
                "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
              },
            },
          },
        },
        job: makeJob({
          payload: {
            kind: "agentTurn",
            message: "summarize",
            model: "openai/gpt-5.6-luna",
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock.mock.calls.map((call) => call[0].thinkLevel)).toEqual([
      "max",
      "ultra",
    ]);
    expect(cronSession.sessionEntry.thinkingLevel).toBe("ultra");
  });

  it("inherits default fallbacks for implicit default-agent cron runs", async () => {
    const jobWithoutModel = makeJobWithoutModel();
    resolveAgentConfigMock.mockReturnValue({
      model: "deepseek/deepseek-v4-pro",
    });
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });

    runWithModelFallbackMock.mockResolvedValueOnce(
      makeSuccessfulRunResult("deepseek", "deepseek-v4-pro"),
    );

    await runCronIsolatedAgentTurn(
      makeParams({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "deepseek/deepseek-v4-pro",
                fallbacks: ["deepseek/deepseek-v4-flash", "moonshot/kimi-k2.6"],
              },
            },
            entries: { default: { model: "deepseek/deepseek-v4-pro" } },
          },
        },
        job: jobWithoutModel,
      }),
    );

    expect(firstMockArg(runWithModelFallbackMock).fallbacksOverride).toEqual([
      "deepseek/deepseek-v4-flash",
      "moonshot/kimi-k2.6",
    ]);
  });

  it("keeps stored cron session model overrides strict for matching string agent models", async () => {
    const jobWithoutModel = makeJobWithoutModel({
      sessionTarget: "session:existing-cron-session",
    });
    resolveAgentConfigMock.mockReturnValue({
      model: "deepseek/deepseek-v4-pro",
    });
    resolveAgentModelFallbacksOverrideMock.mockReturnValue([]);
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });
    resolveAllowedModelRefMock.mockImplementation(({ raw }: { raw: string }) => {
      if (raw === "openai/gpt-5.4") {
        return { ref: { provider: "openai", model: "gpt-5.4" } };
      }
      if (raw === "deepseek/deepseek-v4-pro") {
        return { ref: { provider: "deepseek", model: "deepseek-v4-pro" } };
      }
      return { ref: { provider: "anthropic", model: "claude-opus-4-6" } };
    });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: makeCronSessionEntry({
          modelOverride: "gpt-5.4",
          providerOverride: "openai",
        }),
        isNewSession: false,
      }),
    );

    runWithModelFallbackMock.mockResolvedValueOnce(makeSuccessfulRunResult("openai", "gpt-5.4"));

    await runCronIsolatedAgentTurn(
      makeParams({
        agentId: "main",
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "deepseek/deepseek-v4-pro",
                fallbacks: ["deepseek/deepseek-v4-flash", "moonshot/kimi-k2.6"],
              },
            },
            entries: { main: { model: "deepseek/deepseek-v4-pro" } },
          },
        },
        job: jobWithoutModel,
        sessionKey: "existing-cron-session",
      }),
    );

    expect(firstMockArg(runWithModelFallbackMock).provider).toBe("openai");
    expect(firstMockArg(runWithModelFallbackMock).model).toBe("gpt-5.4");
    expect(firstMockArg(runWithModelFallbackMock).fallbacksOverride).toStrictEqual([]);
  });

  it("uses explicit payload fallbacks when both model and fallbacks are set", async () => {
    const jobWithFallbacks = makeJob({
      payload: {
        kind: "agentTurn",
        message: "summarize",
        model: "google/gemini-2.0-flash",
        fallbacks: ["openai/gpt-4o"],
      },
    });

    runWithModelFallbackMock.mockResolvedValueOnce(makeSuccessfulRunResult());

    await runCronIsolatedAgentTurn(makeParams({ job: jobWithFallbacks }));

    expect(firstMockArg(runWithModelFallbackMock).fallbacksOverride).toEqual(["openai/gpt-4o"]);
  });
});

function makePersistParams(overrides?: Record<string, unknown>) {
  return makeParams({
    job: makeJob({
      id: "digest-job",
      payload: {
        kind: "agentTurn",
        message: "run daily digest",
        model: "anthropic/claude-sonnet-4-6",
      },
    }),
    message: "run daily digest",
    sessionKey: "cron:digest",
    ...overrides,
  });
}

describe("runCronIsolatedAgentTurn — cron model override (#21057)", () => {
  setupModelSuite();
  let cronSession: ReturnType<typeof makeCronSession>;

  beforeEach(() => {
    resolveAllowedModelRefMock.mockReturnValue({
      ref: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });

    cronSession = makeCronSession();
    resolveCronSessionMock.mockReturnValue(cronSession);
  });

  it("session entry already carries cron model at pre-run persist time (race condition)", async () => {
    const persistedSnapshots: unknown[] = [];
    const persist = expectDefined(patchSessionEntryMock.getMockImplementation(), "persist mock");
    patchSessionEntryMock.mockImplementation(async (...args) => {
      const committed = await persist(...args);
      if (committed && !args[0].sessionKey.includes(":run:")) {
        persistedSnapshots.push(structuredClone(committed));
      }
      return committed;
    });

    let snapshotAtRun: unknown;
    runWithModelFallbackMock.mockImplementationOnce(async () => {
      snapshotAtRun = persistedSnapshots.at(-1);
      throw new Error("LLM provider timeout");
    });
    const result = await runCronIsolatedAgentTurn(makePersistParams());
    expect(result.status).toBe("error");

    expect(snapshotAtRun).toMatchObject({
      model: "claude-sonnet-4-6",
      modelProvider: "anthropic",
      systemSent: true,
    });
  });

  it("selects the configured model auth profile separately", async () => {
    const ref = { provider: "openai", model: "gpt-5.6-luna" };
    const modelRef = "openai/gpt-5.6-luna@openai:test-profile";
    resolveConfiguredModelRefMock.mockReturnValue(ref);
    runWithModelFallbackMock.mockResolvedValueOnce(
      makeSuccessfulRunResult(ref.provider, ref.model),
    );
    await runCronIsolatedAgentTurn(
      makePersistParams({
        cfg: {
          auth: { profiles: { "openai:test-profile": { provider: "openai", mode: "token" } } },
          agents: { defaults: { model: { primary: modelRef } } },
        },
        job: makeJob({
          payload: {
            kind: "agentTurn",
            message: "run daily digest",
          },
        }),
      }),
    );
    expect(resolveSessionAuthSelectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.6-luna",
        configuredProfileId: "openai:test-profile",
      }),
    );
  });

  it("returns error without persisting model when payload model is disallowed", async () => {
    resolveAllowedModelRefMock.mockReturnValueOnce({
      error: "Model not allowed: anthropic/claude-sonnet-4-6",
    });

    const result = await runCronIsolatedAgentTurn(makePersistParams());

    expect(result.status).toBe("error");
    expect(result.error).toContain("Model not allowed");
    expect(result.diagnostics?.entries).toEqual([
      expect.objectContaining({
        source: "cron-preflight",
        severity: "error",
        message: expect.stringContaining("Model not allowed"),
        ts: expect.any(Number),
      }),
    ]);
    expect(cronSession.sessionEntry.model).toBeUndefined();
    expect(cronSession.sessionEntry.modelProvider).toBeUndefined();
  });

  it("blocks required work when pre-run persistence fails without configured roles", async () => {
    Object.assign(cronSession.sessionEntry, {
      createdActor: { type: "human", id: "profile-original-creator" },
      sandbox: "required",
    });
    const initialEntry = {
      ...structuredClone(cronSession.sessionEntry),
      skillsSnapshot: undefined,
    };
    cronSession.initialSessionEntry = initialEntry;
    loadSessionEntryMock.mockReturnValue(initialEntry);
    let basePersistCount = 0;
    const persist = expectDefined(patchSessionEntryMock.getMockImplementation(), "persist mock");
    patchSessionEntryMock.mockImplementation(async (...args) => {
      if (!args[0].sessionKey.includes(":run:") && ++basePersistCount === 2) {
        throw new Error("ENOSPC: no space left on device");
      }
      return persist(...args);
    });

    runWithModelFallbackMock.mockResolvedValueOnce(
      makeSuccessfulRunResult("anthropic", "claude-sonnet-4-6"),
    );

    const running = runCronIsolatedAgentTurn(makePersistParams());
    await expect(running).rejects.toThrow("ENOSPC");
    expect(runWithModelFallbackMock).not.toHaveBeenCalled();
    expect(logWarnMock).toHaveBeenCalledWith(
      "[cron:digest-job] Failed to persist pre-run session entry: Error: ENOSPC: no space left on device",
    );
  });
});

describe("runCronIsolatedAgentTurn runtime model thinking", () => {
  setupModelSuite();

  beforeEach(() => {
    mockRunCronFallbackPassthrough();
  });

  it("skips live catalog hydration when model thinking is off", async () => {
    resolveAllowedModelRefMock.mockReturnValue({
      ref: { provider: "ollama", model: "minimax-m3:cloud" },
    });
    loadModelCatalogMock.mockResolvedValue([]);

    await runCronIsolatedAgentTurn(
      makeParams({
        cfg: {
          agents: {
            defaults: { models: { "ollama/minimax-m3:cloud": { params: { thinking: "off" } } } },
          },
        },
        job: makeJob({
          payload: {
            kind: "agentTurn",
            message: "summarize",
            model: "ollama/minimax-m3:cloud",
          },
        }),
      }),
    );

    expect(loadModelCatalogMock).toHaveBeenCalledTimes(1);
    expect(resolveThinkingDefaultMock).not.toHaveBeenCalled();
    const embeddedCall = firstMockArg(runEmbeddedAgentMock);
    expect(embeddedCall.provider).toBe("ollama");
    expect(embeddedCall.model).toBe("minimax-m3:cloud");
    expect(embeddedCall.thinkLevel).toBe("off");
  });

  it("hydrates runtime metadata for a reasoning-capable fallback candidate", async () => {
    resolveAllowedModelRefMock.mockImplementation(({ raw }: { raw: string }) => {
      const [provider, model] = raw.split("/");
      return { ref: { provider, model } };
    });
    loadModelCatalogMock.mockImplementation(({ provider }: { provider?: string }) =>
      provider?.toLowerCase() === "ollama"
        ? [{ provider: "OLLAMA", id: "minimax-m3:cloud", reasoning: true }]
        : [{ provider: "openai", id: "gpt-5.6-sol", reasoning: true }],
    );
    resolveThinkingDefaultMock.mockImplementation(
      ({
        catalog,
        model,
      }: {
        catalog?: Array<{ id?: string; reasoning?: boolean }>;
        model?: string;
      }) =>
        model === "minimax-m3:cloud" &&
        catalog?.some((entry) => entry.id === "minimax-m3:cloud" && entry.reasoning === true)
          ? "medium"
          : "off",
    );
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => {
      await runInitialModelFallbackAttempt(params);
      const result = await runFallbackModelAttempt(params, "ollama", "minimax-m3:cloud", "unknown");
      return {
        result,
        provider: "ollama",
        model: "minimax-m3:cloud",
        attempts: [],
      };
    });

    await runCronIsolatedAgentTurn(
      makeParams({
        cfg: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.6-sol": {},
                "ollama/*": {},
              },
            },
          },
        },
        job: makeJob({
          payload: {
            kind: "agentTurn",
            message: "summarize",
            model: "openai/gpt-5.6-sol",
          },
        }),
      }),
    );

    expect(loadModelCatalogMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "ollama", model: "minimax-m3:cloud" }),
    );
    expect(
      runEmbeddedAgentMock.mock.calls.map(([call]) => ({
        provider: call.provider,
        model: call.model,
        thinkLevel: call.thinkLevel,
      })),
    ).toEqual([
      { provider: "openai", model: "gpt-5.6-sol", thinkLevel: "off" },
      { provider: "ollama", model: "minimax-m3:cloud", thinkLevel: "medium" },
    ]);
  });
});

function makeSwitchParams(overrides?: Record<string, unknown>) {
  return makeParams({
    job: makeJob({
      id: "cron-model-switch-job",
      payload: { kind: "agentTurn", message: "run task", model: "anthropic/claude-sonnet-4-6" },
    }),
    message: "run task",
    sessionKey: "cron:model-switch",
    ...overrides,
  });
}

function requireEmbeddedAgentCall(index: number): Record<string, unknown> {
  return requireRecord(runEmbeddedAgentMock.mock.calls[index]?.[0]);
}

describe("runCronIsolatedAgentTurn — LiveSessionModelSwitchError retry (#57206)", () => {
  setupModelSuite();

  beforeEach(() => {
    resolveAllowedModelRefMock.mockImplementation(({ raw }: { raw: string }) => {
      const [provider, model] = raw.split("/");
      return { ref: { provider, model } };
    });
  });

  it("retries with switched auth profile state from LiveSessionModelSwitchError", async () => {
    resolveSessionAuthSelectionMock.mockResolvedValue({
      profileId: "profile-a",
      source: "auto",
      routeRequirement: undefined,
    });
    const cronSession = makeCronSession({
      sessionEntry: makeCronSessionEntry({
        model: undefined,
        modelProvider: undefined,
        authProfileOverride: "profile-a",
        compactionCount: 7,
        authProfileOverrideCompactionCount: 7,
      }),
      isNewSession: true,
    });
    resolveCronSessionMock.mockReturnValue(cronSession);
    mockRunCronFallbackPassthrough();
    runEmbeddedAgentMock
      .mockImplementationOnce(async (request) => {
        request.userTurnTranscriptRecorder?.markRuntimePersisted({
          role: "user",
          content: "run task",
        });
        throw new LiveSessionModelSwitchError({
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          authProfileId: "profile-b",
          authProfileIdSource: "user",
        });
      })
      .mockResolvedValueOnce(
        makeSuccessfulRunResult("anthropic", "claude-sonnet-4-6").result.result,
      );

    const result = await runCronIsolatedAgentTurn(makeSwitchParams());

    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    const retryParams = requireEmbeddedAgentCall(1);
    expect(retryParams.provider).toBe("anthropic");
    expect(retryParams.model).toBe("claude-sonnet-4-6");
    expect(retryParams.authProfileId).toBe("profile-b");
    expect(retryParams.authProfileIdSource).toBe("user");
    const firstParams = requireEmbeddedAgentCall(0);
    expect(firstParams.authProfileIdSource).toBe("auto");
    expect(runWithModelFallbackMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ userLockedAuthProfileId: undefined }),
    );
    expect(runWithModelFallbackMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ userLockedAuthProfileId: "profile-b" }),
    );
    expect(retryParams.userTurnTranscriptRecorder).toBe(firstParams.userTurnTranscriptRecorder);
    expect(firstParams.suppressNextUserMessagePersistence).toBe(false);
    expect(retryParams.suppressNextUserMessagePersistence).toBe(true);
    expect(cronSession.sessionEntry.authProfileOverride).toBe("profile-b");
    expect(cronSession.sessionEntry.authProfileOverrideSource).toBe("user");
  });

  it("retries a same-model switch with the runtime carried by the error", async () => {
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "openai",
      model: "gpt-5.6-luna",
    });
    const cronSession = makeCronSession({
      sessionEntry: makeCronSessionEntry({
        model: "gpt-5.6-luna",
        modelProvider: "openai",
        agentRuntimeOverride: "openclaw",
        contextTokens: 272_000,
        contextTokensSource: "runtime",
        contextBudgetStatus: {} as NonNullable<
          ReturnType<typeof makeCronSessionEntry>["contextBudgetStatus"]
        >,
      }),
      isNewSession: false,
    });
    resolveCronSessionMock.mockReturnValue(cronSession);
    mockRunCronFallbackPassthrough();
    runEmbeddedAgentMock
      .mockRejectedValueOnce(
        new LiveSessionModelSwitchError({
          provider: "openai",
          model: "gpt-5.6-luna",
          agentRuntimeOverride: "codex",
        }),
      )
      .mockResolvedValueOnce(makeSuccessfulRunResult("openai", "gpt-5.6-luna").result.result);

    const result = await runCronIsolatedAgentTurn(
      makeSwitchParams({
        job: makeJob({
          payload: {
            kind: "agentTurn",
            message: "run task",
            model: "openai/gpt-5.6-luna",
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(requireEmbeddedAgentCall(0).agentHarnessRuntimeOverride).toBe("openclaw");
    expect(requireEmbeddedAgentCall(1).agentHarnessRuntimeOverride).toBe("codex");
    expect(cronSession.sessionEntry.agentRuntimeOverride).toBe("codex");
    expect(cronSession.sessionEntry.contextTokens).toBe(128_000);
    expect(cronSession.sessionEntry.contextTokensSource).toBe("resolved");
    expect(cronSession.sessionEntry.contextBudgetStatus).toBeUndefined();
  });

  it("aborts after exceeding LiveSessionModelSwitchError retry limit (#58466)", async () => {
    const switchError = new LiveSessionModelSwitchError({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    let callCount = 0;
    runWithModelFallbackMock.mockImplementation(async () => {
      callCount++;
      throw switchError;
    });

    const result = await runCronIsolatedAgentTurn(makeSwitchParams());

    expect(result.status).toBe("error");
    expect(callCount).toBe(3);
    expect(logWarnMock).toHaveBeenCalledWith(
      "[cron:cron-model-switch-job] LiveSessionModelSwitchError retry limit reached (2); aborting",
    );
  });
});

const sessionId = "cron-cli-diagnostic-session";

function makeCliOwnershipParams(): RunCronAgentTurnParams {
  return {
    deliveryAttemptFence: null,
    cfg: {},
    deps: {},
    job: {
      id: "cli-diagnostic-job",
      name: "CLI diagnostic ownership",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      sessionTarget: "session:existing-cron-session",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "summarize", model: "test-cli/test-model" },
      state: {},
    },
    message: "summarize",
    sessionKey: "existing-cron-session",
  };
}

describe("cron project: runCronIsolatedAgentTurn CLI ownership", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    isCliProviderMock.mockImplementation((provider: string) => provider === "test-cli");
    resolveConfiguredModelRefMock.mockReturnValue({ provider: "test-cli", model: "test-model" });
    resolveAllowedModelRefMock.mockReturnValue({
      ref: { provider: "test-cli", model: "test-model" },
    });
    resolveThinkingDefaultMock.mockReturnValue("off");
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({ sessionEntry: makeCronSessionEntry({ sessionId }), isNewSession: true }),
    );
    mockRunCronFallbackPassthrough();
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it.each([
    { outcome: "accepted", abort: false },
    { outcome: "canceled", abort: true },
  ])("holds ownership during a pending continuity write ($outcome)", async ({ abort }) => {
    const writeStarted = createDeferred();
    const releaseWrite = createDeferred();
    const upstream = new AbortController();
    const cronSession = makeCronSession({
      sessionEntry: makeCronSessionEntry({ sessionId }),
      isNewSession: true,
    });
    resolveCronSessionMock.mockReturnValue(cronSession);
    const binding: CliSessionBinding = {
      sessionId: "native-cli-session",
      reseedReceipt: {
        version: 1,
        promptHash: "a".repeat(64),
        localSessionId: sessionId,
        userTurnDisposition: "persisted",
      },
    };
    const persist = expectDefined(
      patchSessionEntryMock.getMockImplementation(),
      "expected persistence fixture",
    );
    let continuityCommitted = false;
    const holdContinuityWrite: typeof patchSessionEntryCore = async (scope, update, options) => {
      const assertCommitAllowed = expectDefined(
        options?.workerGuard?.assertCurrent,
        "expected continuity commit guard",
      );
      writeStarted.resolve();
      await releaseWrite.promise;
      assertCommitAllowed();
      const committed = await persist(scope, update, options);
      continuityCommitted = true;
      return committed;
    };
    runCliAgentMock.mockImplementationOnce(async (params) => {
      expect(params.diagnosticOwner).toEqual(
        expect.objectContaining({ sessionId, generation: expect.anything() }),
      );
      expect(params.abortSignal).toBeInstanceOf(AbortSignal);
      expect(params.abortSignal.aborted).toBe(false);
      expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(true);
      patchSessionEntryMock.mockImplementationOnce(holdContinuityWrite);
      return {
        payloads: [{ text: "summary done" }],
        meta: {
          durationMs: 1,
          executionTrace: { runner: "cli" },
          agentMeta: {
            provider: "test-cli",
            model: "test-model",
            cliSessionBinding: binding,
            usage: { input: 1, output: 1 },
          },
        },
      };
    });

    const runPromise = runCronIsolatedAgentTurn({
      ...makeCliOwnershipParams(),
      abortSignal: upstream.signal,
    });
    try {
      await Promise.race([
        writeStarted.promise,
        runPromise.then(() => {
          throw new Error("Cron finished before the continuity write");
        }),
      ]);
      expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(true);
      expect(continuityCommitted).toBe(false);
      if (abort) {
        expect(abortEmbeddedAgentRun(sessionId)).toBe(true);
        expect(upstream.signal.aborted).toBe(false);
      }
      releaseWrite.resolve();
      const result = await runPromise;

      expect(result.status).toBe(abort ? "error" : "ok");
      expect(continuityCommitted).toBe(!abort);
      expect(cronSession.sessionEntry.cliSessionBindings?.["test-cli"]).toEqual(
        abort ? undefined : binding,
      );
      expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(false);
    } finally {
      releaseWrite.resolve();
      await runPromise;
    }
  });

  it("preserves handle cancellation as a terminal abort when the CLI rejects", async () => {
    runCliAgentMock.mockImplementationOnce(async (params) => {
      expect(params.abortSignal.aborted).toBe(false);
      expect(abortEmbeddedAgentRun(sessionId)).toBe(true);
      expect(params.abortSignal.aborted).toBe(true);
      throw Object.assign(new Error("CLI run aborted"), { name: "AbortError" });
    });

    const result = await runCronIsolatedAgentTurn(makeCliOwnershipParams());

    expect(result.status).toBe("error");
    expect(result.error).toBe("agent run aborted | OPENCLAW_DIRECT_ABORT");
    expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(false);
  });
});
