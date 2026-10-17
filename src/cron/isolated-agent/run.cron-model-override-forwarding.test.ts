import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { classifyEmbeddedAgentRunResultForModelFallback } from "../../agents/embedded-agent-runner/result-fallback-classifier.js";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import {
  runFallbackModelAttempt,
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import type { CliSessionReseedReceipt } from "../../config/sessions.js";
import { contextBudgetStatusFixture } from "../../config/sessions/context-budget.test-support.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import * as h from "./run.test-harness.js";

function expectCall(mock: unknown, fields: Record<string, unknown>) {
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(fields));
}

const runAgent = await h.loadRunCronIsolatedAgentTurn();
const opus = { provider: "anthropic", model: "claude-opus-4-6" };
const sonnet = { provider: "anthropic", model: "claude-sonnet-4-6" };
const luna = { provider: "openai", model: "gpt-5.6-luna" };
const gemini = { provider: "google", model: "gemini-2.0-flash" };
const ollama = { provider: "ollama", model: "minimax-m3:cloud" };
const cli = { provider: "claude-cli", model: "claude-opus-4-6" };

function setSession(
  entry: Parameters<typeof h.makeCronSessionEntry>[0],
  overrides: Parameters<typeof h.makeCronSession>[0] = {},
) {
  const session = h.makeCronSession({ ...overrides, sessionEntry: h.makeCronSessionEntry(entry) });
  h.resolveCronSessionMock.mockReturnValue(session);
  return session;
}

function runTurn(overrides?: Record<string, unknown>) {
  return runAgent(
    makeIsolatedAgentParamsFixture({ job: makeJob(), sessionKey: "cron:model-fwd", ...overrides }),
  );
}

setupRunCronIsolatedAgentTurnSuite();
beforeEach(() => {
  h.mockRunCronFallbackPassthrough();
  h.resolveConfiguredModelRefMock.mockReturnValue(opus);
});

function resolveRawModel({ raw }: { raw: string }) {
  const [provider, model] = raw.split("/");
  return { ref: { provider, model } };
}

function useFallback(provider: string, model: string) {
  h.runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => {
    await runInitialModelFallbackAttempt(params);
    return {
      result: await runFallbackModelAttempt(params, provider, model, "unknown"),
      provider,
      model,
      attempts: [],
    };
  });
}

function makeJob(overrides?: Record<string, unknown>) {
  return makeIsolatedAgentJobFixture({
    id: "model-fwd-job",
    payload: { kind: "agentTurn", message: "summarize", model: "google/gemini-2.0-flash" },
    ...overrides,
  });
}

function makeSuccessfulRunResult(provider = "google", model = "gemini-2.0-flash") {
  return {
    result: {
      result: {
        payloads: [{ text: "summary done" }],
        meta: { agentMeta: { model, provider, usage: { input: 100, output: 50 } } },
      },
    },
    provider,
    model,
    attempts: [],
  };
}

function makeJobWithoutModel(overrides?: Record<string, unknown>) {
  return makeJob({ payload: { kind: "agentTurn", message: "summarize" }, ...overrides });
}

function modelConfig(models: Record<string, unknown>) {
  return { agents: { defaults: { models } } };
}

function modelJob(model: string, message = "summarize", overrides: Record<string, unknown> = {}) {
  return makeJob({ ...overrides, payload: { kind: "agentTurn", message, model } });
}

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function mockArg(mock: { mock: { calls: unknown[][] } }, index = 0): Record<string, unknown> {
  return requireRecord(mock.mock.calls[index]?.[0]);
}

function cliBinding(sessionId: string, localSessionId = "openclaw-session") {
  return {
    sessionId,
    reseedReceipt: {
      version: 1 as const,
      promptHash: "a".repeat(64),
      localSessionId,
      userTurnDisposition: "persisted" as const,
    },
  };
}

function recordWrites(
  fail: (key: string, options?: { fallbackEntry?: { systemSent?: boolean } }) => boolean,
) {
  const persist = expectDefined(h.patchSessionEntryMock.getMockImplementation(), "persist mock");
  const writes: { sessionKey: string; entry: unknown }[] = [];
  h.patchSessionEntryMock.mockImplementation(async (...args) => {
    const sessionKey = args[0].sessionKey;
    if (fail(sessionKey, args[2])) {
      throw new Error("ENOSPC: no space left on device");
    }
    const entry = await persist(...args);
    if (entry) {
      writes.push({ sessionKey, entry: structuredClone(entry) });
    }
    return entry;
  });
  return writes;
}

describe("runCronIsolatedAgentTurn — cron model override forwarding (#58065)", () => {
  beforeEach(() => {
    h.resolveAllowedModelRefMock.mockImplementation(({ raw }: { raw: string }) => ({
      ref: raw.includes("gemini") ? gemini : opus,
    }));
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
    h.loadModelCatalogOwnerMock.mockResolvedValueOnce({
      agentId: "main",
      agentDir: "/tmp/owner-agent",
      workspaceDir: "/tmp/replacement-workspace",
      config: ownerConfig,
      modelCatalog: { entries: ownerCatalog, routeVariants: [] },
    });
    h.ensureAgentWorkspaceMock.mockImplementationOnce(async ({ dir }: { dir: string }) => ({
      dir,
    }));
    h.runWithModelFallbackMock.mockResolvedValueOnce(makeSuccessfulRunResult());

    const result = await runTurn({ cfg: callerConfig });

    expect(result.status).toBe("ok");
    expect(h.loadModelCatalogOwnerMock).toHaveBeenCalledWith({
      config: callerConfig,
      readOnly: true,
      allowGatewaySubagentBinding: true,
    });
    expectCall(h.ensureAgentWorkspaceMock, { dir: "/tmp/replacement-workspace" });
    expectCall(h.resolveCronSessionMock, { cfg: ownerConfig, agentId: "main" });
  });

  it("rejects a replacement owner that changes an explicitly requested agent", async () => {
    const callerConfig = { agents: { entries: { main: {}, worker: {} } } };
    h.loadModelCatalogOwnerMock.mockResolvedValueOnce({
      agentId: "main",
      agentDir: "/tmp/main-agent",
      workspaceDir: "/tmp/main-workspace",
      config: callerConfig,
      modelCatalog: { entries: [], routeVariants: [] },
    });

    await expect(runTurn({ cfg: callerConfig, agentId: "worker" })).rejects.toThrow(
      "cron model catalog owner changed from worker to main",
    );
    expect(h.runWithModelFallbackMock).not.toHaveBeenCalled();
  });

  it("does not mark CLI cron runs as model-started before CLI session resolution", async () => {
    h.isCliProviderMock.mockReturnValue(true);
    setSession({ model: undefined, modelProvider: undefined }, { isNewSession: false });
    const getCliSessionStarted = createDeferred();
    const releaseCliSessionLookup = createDeferred<
      { sessionId: string; reseedReceipt: CliSessionReseedReceipt } | undefined
    >();
    h.getCliSessionBindingMock.mockImplementation(async () => {
      getCliSessionStarted.resolve();
      return await releaseCliSessionLookup.promise;
    });
    h.runCliAgentMock.mockImplementation(async ({ onExecutionPhase }) => {
      onExecutionPhase?.({ phase: "model_call_started", ...gemini });
      return {
        payloads: [{ text: "summary done" }],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      };
    });
    const phases: unknown[] = [];

    const runPromise = runTurn({
      sessionKey: "existing-cron-session",
      job: makeJob({ sessionTarget: "session:existing-cron-session" }),
      onExecutionPhase: (info: unknown) => phases.push(info),
    });

    await getCliSessionStarted.promise;
    expect(phases).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ phase: "model_call_started" })]),
    );

    const cliSessionBinding = cliBinding("previous-cli-session");
    releaseCliSessionLookup.resolve(cliSessionBinding);
    const result = await runPromise;

    expect(result.status).toBe("ok");
    const cliCall = mockArg(h.runCliAgentMock);
    expect(cliCall.cliSessionId).toBe("previous-cli-session");
    expect(cliCall.cliSessionBinding).toEqual(cliSessionBinding);
    expect(typeof cliCall.onExecutionPhase).toBe("function");
    expect(phases).toEqual(
      expect.arrayContaining([expect.objectContaining({ phase: "model_call_started" })]),
    );
  });

  it("does not replay accepted CLI work when continuity saving fails", async () => {
    h.isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
    h.resolveAllowedModelRefMock.mockReturnValue({ ref: cli });
    const cronSession = setSession(
      { cliSessionBindings: { "claude-cli": { sessionId: "previous-cli-session" } } },
      { isNewSession: false },
    );
    const localSessionId = cronSession.sessionEntry.sessionId;
    const cliSessionBinding = cliBinding("fresh-cli-session", localSessionId);
    const candidateResult = {
      payloads: [{ text: "summary done" }],
      meta: {
        agentMeta: {
          ...cli,
          sessionId: "fresh-cli-session",
          cliSessionBinding,
          usage: { input: 10, output: 20 },
        },
      },
    };
    h.runCliAgentMock.mockImplementationOnce(async () => {
      h.patchSessionEntryMock.mockRejectedValueOnce(new Error("synthetic continuity write failed"));
      return candidateResult;
    });
    let inspectedCandidate: unknown;
    let inspectedClassification: unknown;
    h.runWithModelFallbackMock.mockImplementationOnce(
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

    const result = await runTurn({
      sessionKey: "existing-cron-session",
      job: makeJob({ sessionTarget: "session:existing-cron-session" }),
    });

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
    expect(h.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(h.runCliAgentMock).toHaveBeenCalledOnce();
    expect(cronSession.sessionEntry.sessionId).toBe(localSessionId);
    expect(cronSession.sessionEntry.cliSessionBindings?.["claude-cli"]).toEqual({
      sessionId: "previous-cli-session",
    });
  });

  it("restores the requested thinking level when a later fallback supports it", async () => {
    h.resolveAllowedModelRefMock.mockImplementation(resolveRawModel);
    h.resolveEffectiveAgentRuntimeMock.mockReturnValue("codex");
    h.isThinkingLevelSupportedMock.mockImplementation(
      ({ model, level }: { model?: string; level?: string }) =>
        model === "gpt-5.6-sol" || level !== "ultra",
    );
    h.resolveSupportedThinkingLevelMock.mockImplementation(
      ({ model, level }: { model?: string; level?: string }) =>
        model === "gpt-5.6-luna" && level === "ultra" ? "max" : level,
    );
    h.loadModelCatalogMock.mockResolvedValue([
      { provider: "openai", id: "gpt-5.6-luna", reasoning: true },
      { provider: "openai", id: "gpt-5.6-sol", reasoning: true },
    ]);
    const cronSession = setSession({ thinkingLevel: "ultra", agentRuntimeOverride: "codex" });
    useFallback("openai", "gpt-5.6-sol");

    const result = await runTurn({
      cfg: modelConfig({
        "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } },
        "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
      }),
      job: modelJob("openai/gpt-5.6-luna"),
    });

    expect(result.status).toBe("ok");
    expect(h.runEmbeddedAgentMock.mock.calls.map((call) => call[0].thinkLevel)).toEqual([
      "max",
      "ultra",
    ]);
    expect(cronSession.sessionEntry.thinkingLevel).toBe("ultra");
  });

  it.each([false, true])(
    "keeps stored model overrides strict, otherwise inherits defaults (stored=%s)",
    async (stored) => {
      const primary = "deepseek/deepseek-v4-pro";
      const fallbacks = ["deepseek/deepseek-v4-flash", "moonshot/kimi-k2.6"];
      h.resolveAgentConfigMock.mockReturnValue({ model: primary });
      h.resolveConfiguredModelRefMock.mockReturnValue({
        provider: "deepseek",
        model: "deepseek-v4-pro",
      });
      if (stored) {
        h.resolveAgentModelFallbacksOverrideMock.mockReturnValue([]);
        h.resolveAllowedModelRefMock.mockImplementation(({ raw }: { raw: string }) =>
          raw === "openai/gpt-5.4" || raw === primary
            ? resolveRawModel({ raw })
            : resolveRawModel({ raw: "anthropic/claude-opus-4-6" }),
        );
        setSession(
          { modelOverride: "gpt-5.4", providerOverride: "openai" },
          { isNewSession: false },
        );
      }
      const agentId = stored ? "main" : "default";
      h.runWithModelFallbackMock.mockResolvedValueOnce(
        stored
          ? makeSuccessfulRunResult("openai", "gpt-5.4")
          : makeSuccessfulRunResult("deepseek", "deepseek-v4-pro"),
      );
      await runTurn({
        cfg: {
          agents: {
            defaults: { model: { primary, fallbacks } },
            entries: { [agentId]: { model: primary } },
          },
        },
        job: makeJobWithoutModel(stored ? { sessionTarget: "session:existing-cron-session" } : {}),
        ...(stored ? { agentId, sessionKey: "existing-cron-session" } : {}),
      });
      const request = mockArg(h.runWithModelFallbackMock);
      expect(request.fallbacksOverride).toStrictEqual(stored ? [] : fallbacks);
      if (stored) {
        expect(request).toMatchObject({ provider: "openai", model: "gpt-5.4" });
      }
    },
  );
});

function runPersist(overrides?: Record<string, unknown>) {
  return runTurn({
    job: modelJob("anthropic/claude-sonnet-4-6", "run daily digest", { id: "digest-job" }),
    message: "run daily digest",
    sessionKey: "cron:digest",
    ...overrides,
  });
}

describe("runCronIsolatedAgentTurn — cron model override (#21057)", () => {
  let cronSession: ReturnType<typeof h.makeCronSession>;

  beforeEach(() => {
    h.resolveAllowedModelRefMock.mockReturnValue({ ref: sonnet });

    cronSession = h.makeCronSession();
    h.resolveCronSessionMock.mockReturnValue(cronSession);
  });

  it.each([false, true])(
    "persists the model and harness before execution (pre-run write fails: %s)",
    async (preRunWriteFails) => {
      let failNextBaseWrite = preRunWriteFails;
      const persistedSnapshots = recordWrites((sessionKey) => {
        if (failNextBaseWrite && !sessionKey.includes(":run:")) {
          failNextBaseWrite = false;
          return true;
        }
        return false;
      });

      let snapshotsAtRun: typeof persistedSnapshots = [];
      h.runEmbeddedAgentMock.mockImplementationOnce(async () => {
        snapshotsAtRun = structuredClone(persistedSnapshots);
        return {
          payloads: [{ text: "summary done" }],
          meta: { agentMeta: sonnet },
        };
      });
      const result = await runPersist();
      expect(result.status).toBe("ok");

      expect(snapshotsAtRun).toHaveLength(2);
      expect(snapshotsAtRun.filter(({ sessionKey }) => !sessionKey.includes(":run:"))).toHaveLength(
        1,
      );
      for (const { entry } of snapshotsAtRun) {
        expect(entry).toMatchObject({
          model: "claude-sonnet-4-6",
          modelProvider: "anthropic",
          agentHarnessId: "openclaw",
          systemSent: true,
        });
      }
      if (preRunWriteFails) {
        expect(h.logWarnMock).toHaveBeenCalledWith(
          "[cron:digest-job] Failed to persist pre-run session entry: Error: ENOSPC: no space left on device",
        );
      }
    },
  );

  it("selects the configured model auth profile separately", async () => {
    const modelRef = "openai/gpt-5.6-luna@openai:test-profile";
    h.resolveConfiguredModelRefMock.mockReturnValue(luna);
    h.runWithModelFallbackMock.mockResolvedValueOnce(
      makeSuccessfulRunResult(luna.provider, luna.model),
    );
    await runPersist({
      cfg: {
        auth: { profiles: { "openai:test-profile": { provider: "openai", mode: "token" } } },
        agents: { defaults: { model: { primary: modelRef } } },
      },
      job: makeJob({ payload: { kind: "agentTurn", message: "run daily digest" } }),
    });
    expectCall(h.resolveSessionAuthSelectionMock, {
      provider: "openai",
      modelId: "gpt-5.6-luna",
      configuredProfileId: "openai:test-profile",
    });
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
    h.loadSessionEntryMock.mockReturnValue(initialEntry);
    recordWrites(
      (key, options) => !key.includes(":run:") && options?.fallbackEntry?.systemSent === true,
    );

    h.runWithModelFallbackMock.mockResolvedValueOnce(
      makeSuccessfulRunResult("anthropic", "claude-sonnet-4-6"),
    );

    const running = runPersist();
    await expect(running).rejects.toThrow("ENOSPC");
    expect(h.runWithModelFallbackMock).not.toHaveBeenCalled();
    expect(h.logWarnMock).toHaveBeenCalledWith(
      "[cron:digest-job] Failed to persist pre-run session entry: Error: ENOSPC: no space left on device",
    );
  });
});

describe("runCronIsolatedAgentTurn runtime model thinking", () => {
  it("skips live catalog hydration when model thinking is off", async () => {
    h.resolveAllowedModelRefMock.mockReturnValue({ ref: ollama });
    await runTurn({
      cfg: modelConfig({ "ollama/minimax-m3:cloud": { params: { thinking: "off" } } }),
      job: modelJob("ollama/minimax-m3:cloud"),
    });

    expect(h.loadModelCatalogMock).toHaveBeenCalledTimes(1);
    expect(h.resolveThinkingDefaultMock).not.toHaveBeenCalled();
    const embeddedCall = mockArg(h.runEmbeddedAgentMock);
    expect(embeddedCall).toMatchObject({ ...ollama, thinkLevel: "off" });
  });

  it("hydrates runtime metadata for a reasoning-capable fallback candidate", async () => {
    h.resolveAllowedModelRefMock.mockImplementation(resolveRawModel);
    h.loadModelCatalogMock.mockImplementation(({ provider }: { provider?: string }) =>
      provider?.toLowerCase() === "ollama"
        ? [{ provider: "OLLAMA", id: "minimax-m3:cloud", reasoning: true }]
        : [{ provider: "openai", id: "gpt-5.6-sol", reasoning: true }],
    );
    h.resolveThinkingDefaultMock.mockImplementation(
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
    useFallback("ollama", "minimax-m3:cloud");

    await runTurn({
      cfg: modelConfig({ "openai/gpt-5.6-sol": {}, "ollama/*": {} }),
      job: modelJob("openai/gpt-5.6-sol"),
    });

    expectCall(h.loadModelCatalogMock, ollama);
    expect(
      h.runEmbeddedAgentMock.mock.calls.map(([call]) => ({
        provider: call.provider,
        model: call.model,
        thinkLevel: call.thinkLevel,
      })),
    ).toEqual([
      { provider: "openai", model: "gpt-5.6-sol", thinkLevel: "off" },
      { ...ollama, thinkLevel: "medium" },
    ]);
  });
});

function runSwitch(overrides?: Record<string, unknown>) {
  return runTurn({
    job: modelJob("anthropic/claude-sonnet-4-6", "run task", { id: "cron-model-switch-job" }),
    message: "run task",
    sessionKey: "cron:model-switch",
    ...overrides,
  });
}

describe("runCronIsolatedAgentTurn — LiveSessionModelSwitchError retry (#57206)", () => {
  beforeEach(() => {
    h.resolveAllowedModelRefMock.mockImplementation(resolveRawModel);
  });

  it("retries with switched auth profile state from LiveSessionModelSwitchError", async () => {
    h.resolveSessionAuthSelectionMock.mockResolvedValue({
      profileId: "profile-a",
      source: "auto",
      routeRequirement: undefined,
    });
    const cronSession = setSession({
      authProfileOverride: "profile-a",
      compactionCount: 7,
      authProfileOverrideCompactionCount: 7,
    });
    h.runEmbeddedAgentMock
      .mockImplementationOnce(async (request) => {
        request.userTurnTranscriptRecorder?.markRuntimePersisted({
          role: "user",
          content: "run task",
        });
        throw new LiveSessionModelSwitchError({
          ...sonnet,
          authProfileId: "profile-b",
          authProfileIdSource: "user",
        });
      })
      .mockResolvedValueOnce(
        makeSuccessfulRunResult("anthropic", "claude-sonnet-4-6").result.result,
      );

    const result = await runSwitch();

    expect(result.status).toBe("ok");
    expect(h.runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    const retryParams = mockArg(h.runEmbeddedAgentMock, 1);
    expect(retryParams).toMatchObject({
      ...sonnet,
      authProfileId: "profile-b",
      authProfileIdSource: "user",
      suppressNextUserMessagePersistence: true,
    });
    const firstParams = mockArg(h.runEmbeddedAgentMock);
    expect(firstParams).toMatchObject({
      authProfileIdSource: "auto",
      suppressNextUserMessagePersistence: false,
    });
    expect(h.runWithModelFallbackMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ userLockedAuthProfileId: undefined }),
    );
    expect(h.runWithModelFallbackMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ userLockedAuthProfileId: "profile-b" }),
    );
    expect(retryParams.userTurnTranscriptRecorder).toBe(firstParams.userTurnTranscriptRecorder);
    expect(cronSession.sessionEntry).toMatchObject({
      authProfileOverride: "profile-b",
      authProfileOverrideSource: "user",
    });
  });

  it("retries persistence after a pre-candidate model switch write fails", async () => {
    let failSwitchWrite = false;
    const writes = recordWrites((key) => {
      if (!key.includes(":run:") && failSwitchWrite) {
        failSwitchWrite = false;
        return true;
      }
      return false;
    });
    h.runWithModelFallbackMock.mockImplementationOnce(async () => {
      failSwitchWrite = true;
      throw new LiveSessionModelSwitchError({
        ...sonnet,
        authProfileId: "profile-b",
        authProfileIdSource: "user",
      });
    });
    let persistedAtExecution: unknown;
    h.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      persistedAtExecution = structuredClone(
        writes.findLast(({ sessionKey }) => !sessionKey.includes(":run:"))?.entry,
      );
      return makeSuccessfulRunResult("anthropic", "claude-sonnet-4-6").result.result;
    });

    const result = await runSwitch();

    expect(result.status).toBe("ok");
    expect(persistedAtExecution).toMatchObject({
      authProfileOverride: "profile-b",
      authProfileOverrideSource: "user",
    });
    expect(h.logWarnMock).toHaveBeenCalledWith(
      "[cron:cron-model-switch-job] Failed to persist model switch session entry: Error: ENOSPC: no space left on device",
    );
  });

  it("retries a same-model switch with the runtime carried by the error", async () => {
    h.resolveConfiguredModelRefMock.mockReturnValue(luna);
    const cronSession = setSession(
      {
        model: "gpt-5.6-luna",
        modelProvider: "openai",
        agentRuntimeOverride: "openclaw",
        contextTokens: 272_000,
        contextTokensSource: "runtime",
        contextBudgetStatus: contextBudgetStatusFixture({ ...luna, contextTokenBudget: 272_000 }),
      },
      { isNewSession: false },
    );
    h.runEmbeddedAgentMock
      .mockRejectedValueOnce(
        new LiveSessionModelSwitchError({ ...luna, agentRuntimeOverride: "codex" }),
      )
      .mockResolvedValueOnce(makeSuccessfulRunResult("openai", "gpt-5.6-luna").result.result);

    const result = await runSwitch({
      job: modelJob("openai/gpt-5.6-luna", "run task"),
    });

    expect(result.status).toBe("ok");
    expect(mockArg(h.runEmbeddedAgentMock).agentHarnessRuntimeOverride).toBe("openclaw");
    expect(mockArg(h.runEmbeddedAgentMock, 1).agentHarnessRuntimeOverride).toBe("codex");
    expect(cronSession.sessionEntry).toMatchObject({
      agentRuntimeOverride: "codex",
      contextTokens: 128_000,
      contextTokensSource: "resolved",
    });
    expect(cronSession.sessionEntry.contextBudgetStatus).toBeUndefined();
  });

  it("aborts after exceeding LiveSessionModelSwitchError retry limit (#58466)", async () => {
    const switchError = new LiveSessionModelSwitchError(sonnet);

    h.runWithModelFallbackMock.mockRejectedValue(switchError);

    const result = await runSwitch();

    expect(result.status).toBe("error");
    expect(h.runWithModelFallbackMock).toHaveBeenCalledTimes(3);
    expect(h.logWarnMock).toHaveBeenCalledWith(
      "[cron:cron-model-switch-job] LiveSessionModelSwitchError retry limit reached (2); aborting",
    );
  });
});
