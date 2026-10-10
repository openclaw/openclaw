import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runInitialModelFallbackAttempt } from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import { isSessionWorkAdmissionActive } from "../../sessions/session-lifecycle-admission.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { mockCall } from "../../test-utils/mock-call-assertions.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  cleanupBrowserSessionsForLifecycleEndMock,
  isCliProviderMock,
  getCliSessionBindingMock,
  removeCronRunContinuationSessionIfIdleMock,
  loadSessionEntryMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  mockRunCronFallbackPassthrough,
  patchSessionEntryMock,
  resolveCronSessionMock,
  runCliAgentMock,
  runEmbeddedAgentMock,
  buildWorkspaceSkillSnapshotMock,
  dispatchCronDeliveryMock,
  lookupModelContextTokensMock,
  logWarnMock,
  resolveAgentSkillsFilterMock,
  resolveAllowedModelRefMock,
  resolveEffectiveAgentRuntimeMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";
import { resolveCronAgentSessionKey } from "./session-key.js";

// Session key isolation tests cover separate keys for concurrent cron runs.

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn isolated session identity", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  it("isolates run identities while retaining job-level prompt-cache affinity", async () => {
    const baseKey = "agent:default:cron:daily-monitor";
    resolveCronSessionMock
      .mockReturnValueOnce(
        makeCronSession({ sessionEntry: makeCronSessionEntry({ sessionId: "run-a" }) }),
      )
      .mockReturnValueOnce(
        makeCronSession({ sessionEntry: makeCronSessionEntry({ sessionId: "run-b" }) }),
      );
    mockRunCronFallbackPassthrough();
    removeCronRunContinuationSessionIfIdleMock.mockImplementation(async (sessionKey) => {
      expect(sessionKey).toMatch(/:run:run-[ab]$/u);
      expect(isSessionWorkAdmissionActive("/tmp/store.json", [sessionKey])).toBe(false);
    });
    const params = makeIsolatedAgentParamsFixture({
      sessionKey: "cron:daily-monitor",
      job: makeIsolatedAgentJobFixture({
        payload: { kind: "agentTurn", message: "test", lightContext: true },
      }),
    });
    const first = await runCronIsolatedAgentTurn(params);
    const second = await runCronIsolatedAgentTurn(params);
    expect([first.status, second.status]).toEqual(["ok", "ok"]);
    expect([first.sessionKey, second.sessionKey]).toEqual([
      `${baseKey}:run:run-a`,
      `${baseKey}:run:run-b`,
    ]);
    expect(resolveCronSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ forceNew: true, sessionKey: baseKey }),
    );
    const [a, b] = runEmbeddedAgentMock.mock.calls.map(([request]) => request);
    expect(a).toMatchObject({
      sessionId: "run-a",
      sessionKey: first.sessionKey,
      sessionTarget: {
        agentId: "default",
        sessionId: "run-a",
        sessionKey: first.sessionKey,
        storePath: "/tmp/store.json",
      },
      bootstrapContextMode: "lightweight",
      bootstrapContextRunKind: "cron",
    });
    expect(a.sessionFile).toBeUndefined();
    expect(b.sessionId).toBe("run-b");
    expect(a.promptCacheKey).toMatch(/^openclaw-cron-[a-f0-9]{32}$/u);
    expect(b.promptCacheKey).toBe(a.promptCacheKey);
    expect(a.promptCacheKey).not.toContain("run-a");
    expect(a.promptCacheKey).not.toContain("daily-monitor");
    expect(cleanupBrowserSessionsForLifecycleEndMock).toHaveBeenCalledTimes(2);
    expect(cleanupBrowserSessionsForLifecycleEndMock).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      sessionKeys: [first.sessionKey],
      onWarn: expect.any(Function),
    });
    expect(removeCronRunContinuationSessionIfIdleMock).toHaveBeenCalledTimes(2);
    const executionOrder = runEmbeddedAgentMock.mock.invocationCallOrder[0];
    if (executionOrder === undefined) {
      throw new Error("Expected embedded cron execution order");
    }
    for (const sessionKey of [baseKey, first.sessionKey]) {
      const index = patchSessionEntryMock.mock.calls.findIndex(
        ([scope]) => scope.sessionKey === sessionKey,
      );
      expect(index).toBeGreaterThanOrEqual(0);
      expect(patchSessionEntryMock.mock.invocationCallOrder[index]).toBeLessThan(executionOrder);
    }
  });

  it.each([
    {
      name: "missing harness",
      key: "harness:codex:supervision:native-thread",
      locked: false,
      error: /reserved for agent harness-owned sessions/i,
    },
    {
      name: "locked harness",
      key: "harness:codex:supervision:native-thread",
      locked: true,
      error: /reserved for agent harness-owned sessions/i,
    },
    {
      name: "locked ordinary",
      key: "project-native-session",
      locked: true,
      error: /identity is locked and cannot be replaced or shared/i,
    },
  ])("rejects detached execution for a $name session", async ({ key, locked, error }) => {
    const sessionKey = `agent:default:${key}`;
    if (locked) {
      const entry = makeCronSessionEntry({
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        sessionId: "native-session",
      });
      resolveCronSessionMock.mockReturnValue(
        makeCronSession({
          initialSessionEntry: entry,
          isNewSession: false,
          sessionEntry: entry,
          store: { [sessionKey]: entry },
        }),
      );
    }
    await expect(
      runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({
          sessionKey,
          job: makeIsolatedAgentJobFixture({ sessionTarget: `session:${sessionKey}` }),
        }),
      ),
    ).rejects.toThrow(error);
    expect(resolveCronSessionMock).toHaveBeenCalledOnce();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("continues a pre-existing unlocked harness-prefixed session as an ordinary session", async () => {
    const sessionKey = "agent:default:harness:legacy-notes";
    const legacyEntry = makeCronSessionEntry({
      agentHarnessId: "codex",
      sessionId: "legacy-session",
    });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        initialSessionEntry: legacyEntry,
        isNewSession: false,
        sessionEntry: { ...legacyEntry },
        store: { [sessionKey]: { ...legacyEntry } },
      }),
    );
    loadSessionEntryMock.mockReturnValue(legacyEntry);
    mockRunCronFallbackPassthrough();

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        sessionKey,
        job: makeIsolatedAgentJobFixture({ sessionTarget: `session:${sessionKey}` }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(result.sessionKey).toBe(sessionKey);
    expect(resolveCronSessionMock).toHaveBeenCalledOnce();
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject({
      sessionKey,
      sessionId: "legacy-session",
    });
    expect(cleanupBrowserSessionsForLifecycleEndMock).not.toHaveBeenCalled();
  });

  it("uses a run-scoped key for CLI isolated cron execution", async () => {
    isCliProviderMock.mockReturnValue(true);
    getCliSessionBindingMock.mockReturnValue({ sessionId: "previous-cli-session" });
    const cronSession = makeCronSession({
      sessionEntry: {
        ...makeCronSession().sessionEntry,
        sessionId: "isolated-cli-run-1",
      },
    });
    resolveCronSessionMock.mockReturnValue(cronSession);
    mockRunCronFallbackPassthrough();
    runCliAgentMock.mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        sessionKey: "cron:cli-monitor",
        job: makeIsolatedAgentJobFixture({
          payload: {
            kind: "agentTurn",
            message: "test",
            lightContext: true,
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(result.sessionKey).toBe("agent:default:cron:cli-monitor:run:isolated-cli-run-1");
    expect(runCliAgentMock).toHaveBeenCalledOnce();
    const runRequest = runCliAgentMock.mock.calls[0]?.[0];
    expect(runRequest.sessionId).toBe("isolated-cli-run-1");
    expect(runRequest.sessionKey).toBe("agent:default:cron:cli-monitor:run:isolated-cli-run-1");
    expect(runRequest.sessionTarget).toEqual({
      agentId: "default",
      sessionId: "isolated-cli-run-1",
      sessionKey: "agent:default:cron:cli-monitor:run:isolated-cli-run-1",
      storePath: cronSession.storePath,
    });
    expect(runRequest.sessionKey).not.toBe("agent:default:cron:cli-monitor");
    expect(runRequest.promptCacheKey).toBeUndefined();
    expect(runRequest.bootstrapContextMode).toBe("lightweight");
    expect(runRequest.bootstrapContextRunKind).toBe("cron");
    expect(runRequest.cleanupCliLiveSessionOnRunEnd).toBe(true);
    expect(runRequest.cliSessionId).toBeUndefined();
  });

  it("runs externally sourced CLI hook turns", async () => {
    isCliProviderMock.mockReturnValue(true);
    mockRunCronFallbackPassthrough();
    runCliAgentMock.mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        sessionKey: "hook:webhook:cli-monitor",
        job: makeIsolatedAgentJobFixture({
          payload: {
            kind: "agentTurn",
            message: "test",
            externalContentSource: "webhook",
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runCliAgentMock).toHaveBeenCalledOnce();
    const runRequest = runCliAgentMock.mock.calls[0]?.[0] as {
      userTurnTranscriptRecorder: UserTurnTranscriptRecorder;
    };
    expect(runRequest.userTurnTranscriptRecorder.message?.provenance).toBeUndefined();
  });
});

const requireRecord = createRequireRecord("record", "expected-label-object");

describe("runCronIsolatedAgentTurn — skill filter", () => {
  setupRunCronIsolatedAgentTurnSuite();

  async function runSkillFilterCase(overrides?: Record<string, unknown>) {
    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture(overrides));
    expect(result.status).toBe("ok");
    return result;
  }

  it("persists the selected harness on base and run rows before turn startup fails", async () => {
    const persistedAtStartup = new Map<string, Record<string, unknown>>();
    resolveEffectiveAgentRuntimeMock.mockReturnValue("codex");
    mockRunCronFallbackPassthrough();
    runEmbeddedAgentMock.mockImplementationOnce(async () => {
      for (const [index, result] of patchSessionEntryMock.mock.results.entries()) {
        const scope = requireRecord(mockCall(patchSessionEntryMock, index)[0], "patch scope");
        const entry = requireRecord(await result.value, "persisted session entry");
        persistedAtStartup.set(String(scope.sessionKey), entry);
      }
      throw new Error("turn/start rejected before result metadata");
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({ agentId: "main" }),
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("turn/start rejected before result metadata");
    expect(persistedAtStartup.get("agent:main:cron:test")).toMatchObject({
      sessionId: "test-session-id",
      agentHarnessId: "codex",
    });
    expect(persistedAtStartup.get("agent:main:cron:test:run:test-session-id")).toMatchObject({
      sessionId: "test-session-id",
      agentHarnessId: "codex",
    });
  });

  it("reuses cached snapshot when version and normalized skillFilter are unchanged", async () => {
    resolveAgentSkillsFilterMock.mockReturnValue([" weather ", "meme-factory", "weather"]);
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: makeCronSessionEntry({
          skillsSnapshot: {
            prompt: "<available_skills><skill>weather</skill></available_skills>",
            skills: [{ name: "weather" }],
            skillFilter: ["meme-factory", "weather"],
            version: 42,
          },
        }),
      }),
    );

    await runSkillFilterCase({
      cfg: { agents: { entries: { "weather-bot": { skills: ["weather", "meme-factory"] } } } },
      agentId: "weather-bot",
    });
    expect(buildWorkspaceSkillSnapshotMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      model: "anthropic/claude-sonnet-4-6",
      error: "model not allowed: anthropic/claude-sonnet-4-6",
      expected:
        "automation model override 'anthropic/claude-sonnet-4-6' rejected by agents.defaults.modelPolicy.allow: anthropic/claude-sonnet-4-6 is not in [openai/gpt-5.4]",
    },
    {
      model: "openai/",
      error: "invalid model: openai/",
      expected: "automation model override 'openai/' rejected: invalid model: openai/",
    },
  ])("rejects payload model $model before execution", async ({ model, error, expected }) => {
    resolveAllowedModelRefMock.mockReturnValueOnce({ error });
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg: { agents: { defaults: { modelPolicy: { allow: ["openai/gpt-5.4"] } } } },
        job: makeIsolatedAgentJobFixture({
          payload: { kind: "agentTurn", message: "test", model },
        }),
      }),
    );
    expect(result).toMatchObject({ status: "error", error: expected });
    expect(logWarnMock).not.toHaveBeenCalled();
    expect(runWithModelFallbackMock).not.toHaveBeenCalled();
  });

  describe("CLI session handoff (issue #29774)", () => {
    function mockCliFallbackInvocation() {
      isCliProviderMock.mockReturnValue(true);
      runWithModelFallbackMock.mockImplementationOnce(async (params) => ({
        result: await runInitialModelFallbackAttempt(params, "claude-cli", "claude-opus-4-6"),
        provider: "claude-cli",
        model: "claude-opus-4-6",
        attempts: [],
      }));
    }

    it("passes the cron abort signal to CLI runs and drops late CLI results", async () => {
      const abortController = new AbortController();
      const cliStarted = createDeferred();
      runCliAgentMock.mockImplementationOnce(async (params: { abortSignal?: AbortSignal }) => {
        expect(params.abortSignal).not.toBe(abortController.signal);
        expect(params.abortSignal?.aborted).toBe(false);
        cliStarted.resolve();
        await new Promise<void>((resolve) => {
          params.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          payloads: [{ text: "late cli output" }],
          meta: { agentMeta: { sessionId: "late-cli-session", usage: { input: 5, output: 10 } } },
        };
      });
      mockCliFallbackInvocation();

      const runPromise = runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({ abortSignal: abortController.signal }),
      );
      await cliStarted.promise;
      abortController.abort("cron: job execution timed out");

      const result = await runPromise;

      expect(result.status).toBe("error");
      expect(result.error).toBe("cron: job execution timed out");
      expect(dispatchCronDeliveryMock).not.toHaveBeenCalled();
    });
  });

  it.each([
    {
      name: "reported runtime",
      reported: true,
      locked: false,
      expected: 1_000_000,
      source: "runtime",
    },
    {
      name: "retained lower runtime",
      reported: false,
      locked: false,
      expected: 222_000,
      source: "runtime",
    },
    { name: "locked legacy", reported: false, locked: true, expected: 222_000, source: undefined },
  ])(
    "persists the $name context window and provenance",
    async ({ reported, locked, expected, source }) => {
      const session = makeCronSession({
        sessionEntry: makeCronSessionEntry({
          modelProvider: "openai",
          model: "gpt-5.4",
          agentHarnessId: reported ? "openclaw" : "codex",
          contextTokens: 222_000,
          contextTokensSource: locked ? undefined : reported ? "resolved" : "runtime",
          modelSelectionLocked: locked,
        }),
      });
      resolveCronSessionMock.mockReturnValue(session);
      lookupModelContextTokensMock.mockReturnValue(512_000);
      runWithModelFallbackMock.mockResolvedValueOnce({
        result: {
          result: {
            payloads: [{ text: "test output" }],
            meta: {
              agentMeta: {
                provider: "openai",
                model: "gpt-5.4",
                agentHarnessId: "codex",
                ...(reported ? { contextTokens: 1_000_000, contextTokensSource: "runtime" } : {}),
              },
            },
          },
        },
        provider: "openai",
        model: "gpt-5.4",
        attempts: [],
      });
      await runSkillFilterCase();
      expect(session.sessionEntry).toMatchObject({
        agentHarnessId: "codex",
        contextTokens: expected,
        contextTokensSource: source,
      });
    },
  );
});

describe("resolveCronAgentSessionKey", () => {
  it("canonicalizes agent:id:main alias to configured mainKey (#29683)", () => {
    const cfg = { session: { mainKey: "work" } };
    expect(
      resolveCronAgentSessionKey({
        sessionKey: "agent:ops:main",
        agentId: "ops",
        mainKey: "work",
        cfg,
      }),
    ).toBe("agent:ops:work");
  });
});
