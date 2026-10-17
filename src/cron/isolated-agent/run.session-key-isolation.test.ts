import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { assert, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runInitialModelFallbackAttempt } from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import { isSessionWorkAdmissionActive } from "../../sessions/session-lifecycle-admission.js";
import { mockCall } from "../../test-utils/mock-call-assertions.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import * as h from "./run.test-harness.js";
import { resolveCronAgentSessionKey } from "./session-key.js";

const runAgent = await h.loadRunCronIsolatedAgentTurn();

function runJob(job: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return runAgent(makeJobParams(job, overrides));
}

function makeJobParams(job: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return makeIsolatedAgentParamsFixture({ ...overrides, job: makeIsolatedAgentJobFixture(job) });
}

function makeSession(entry: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return h.makeCronSession({ ...overrides, sessionEntry: h.makeCronSessionEntry(entry) });
}

function setStoredSession(sessionKey: string, entry: ReturnType<typeof h.makeCronSessionEntry>) {
  h.resolveCronSessionMock.mockReturnValue(
    makeSession(
      { ...entry },
      {
        initialSessionEntry: entry,
        isNewSession: false,
        store: { [sessionKey]: { ...entry } },
      },
    ),
  );
}

function sessionTarget(sessionId: string, sessionKey?: string, storePath = "/tmp/store.json") {
  return { agentId: "default", sessionId, sessionKey, storePath };
}

describe("runCronIsolatedAgentTurn isolated session identity", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  it("isolates run identities while retaining job-level prompt-cache affinity", async () => {
    const baseKey = "agent:default:cron:daily-monitor";
    const firstSession = makeSession({ sessionId: "run-a" });
    h.resolveCronSessionMock.mockReturnValueOnce(firstSession);
    h.mockRunCronFallbackPassthrough();
    h.removeCronRunContinuationSessionIfIdleMock.mockImplementation(async (sessionKey) => {
      expect(sessionKey).toMatch(/:run:run-[ab]$/u);
      expect(isSessionWorkAdmissionActive("/tmp/store.json", [sessionKey])).toBe(false);
    });
    const params = makeJobParams(
      { payload: { kind: "agentTurn", message: "test", lightContext: true } },
      { sessionKey: "cron:daily-monitor" },
    );
    const first = await runAgent(params);
    h.resolveCronSessionMock.mockReturnValueOnce(
      makeSession({ sessionId: "run-b" }, { initialSessionEntry: firstSession.sessionEntry }),
    );
    const second = await runAgent(params);
    expect([first.status, second.status]).toEqual(["ok", "ok"]);
    expect([first.sessionKey, second.sessionKey]).toEqual([
      `${baseKey}:run:run-a`,
      `${baseKey}:run:run-b`,
    ]);
    expect(h.resolveCronSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ forceNew: true, sessionKey: baseKey }),
    );
    const [a, b] = h.runEmbeddedAgentMock.mock.calls.map(([request]) => request);
    expect(a).toMatchObject({
      sessionId: "run-a",
      sessionKey: first.sessionKey,
      sessionTarget: sessionTarget("run-a", first.sessionKey),
      bootstrapContextMode: "lightweight",
      bootstrapContextRunKind: "cron",
    });
    expect(a.sessionFile).toBeUndefined();
    expect(b.sessionId).toBe("run-b");
    expect(a.promptCacheKey).toMatch(/^openclaw-cron-[a-f0-9]{32}$/u);
    expect(b.promptCacheKey).toBe(a.promptCacheKey);
    expect(a.promptCacheKey).not.toContain("run-a");
    expect(a.promptCacheKey).not.toContain("daily-monitor");
    expect(h.cleanupBrowserSessionsForLifecycleEndMock).toHaveBeenCalledTimes(2);
    expect(h.cleanupBrowserSessionsForLifecycleEndMock).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      sessionKeys: [first.sessionKey],
      onWarn: expect.any(Function),
    });
    expect(h.removeCronRunContinuationSessionIfIdleMock).toHaveBeenCalledTimes(2);
    const executionOrder = h.runEmbeddedAgentMock.mock.invocationCallOrder[0];
    assert(executionOrder !== undefined, "Expected embedded cron execution order");
    for (const sessionKey of [baseKey, first.sessionKey]) {
      const index = h.patchSessionEntryMock.mock.calls.findIndex(
        ([scope]) => scope.sessionKey === sessionKey,
      );
      expect(index).toBeGreaterThanOrEqual(0);
      expect(h.patchSessionEntryMock.mock.invocationCallOrder[index]).toBeLessThan(executionOrder);
    }
  });

  it.each([
    [
      "harness:codex:supervision:native-thread",
      false,
      /reserved for agent harness-owned sessions/i,
    ],
    ["harness:codex:supervision:native-thread", true, /reserved for agent harness-owned sessions/i],
    ["project-native-session", true, /identity is locked and cannot be replaced or shared/i],
  ] as const)("rejects detached execution for %s (locked=%s)", async (key, locked, error) => {
    const sessionKey = `agent:default:${key}`;
    if (locked) {
      const entry = h.makeCronSessionEntry({
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        sessionId: "native-session",
      });
      setStoredSession(sessionKey, entry);
    }
    await expect(
      runJob({ sessionTarget: `session:${sessionKey}` }, { sessionKey }),
    ).rejects.toThrow(error);
    expect(h.resolveCronSessionMock).toHaveBeenCalledOnce();
    expect(h.runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("continues a pre-existing unlocked harness-prefixed session as an ordinary session", async () => {
    const sessionKey = "agent:default:harness:legacy-notes";
    const legacyEntry = h.makeCronSessionEntry({
      agentHarnessId: "codex",
      sessionId: "legacy-session",
    });
    setStoredSession(sessionKey, legacyEntry);
    h.loadSessionEntryMock.mockReturnValue(legacyEntry);
    h.mockRunCronFallbackPassthrough();

    const result = await runJob({ sessionTarget: `session:${sessionKey}` }, { sessionKey });

    expect(result).toMatchObject({ status: "ok", sessionKey });
    expect(h.resolveCronSessionMock).toHaveBeenCalledOnce();
    expect(h.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(h.runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject({
      sessionKey,
      sessionId: "legacy-session",
    });
    expect(h.cleanupBrowserSessionsForLifecycleEndMock).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "runs CLI cron with isolated identity (external hook=%s)",
    async (external) => {
      h.isCliProviderMock.mockReturnValue(true);
      if (!external) {
        h.getCliSessionBindingMock.mockReturnValue({ sessionId: "previous-cli-session" });
      }
      const cronSession = makeSession(external ? {} : { sessionId: "isolated-cli-run-1" });
      if (!external) {
        h.resolveCronSessionMock.mockReturnValue(cronSession);
      }
      h.mockRunCronFallbackPassthrough();
      h.runCliAgentMock.mockResolvedValue({
        payloads: [{ text: "done" }],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      });
      const result = await runJob(
        {
          payload: {
            kind: "agentTurn",
            message: "test",
            ...(external ? { externalContentSource: "webhook" } : { lightContext: true }),
          },
        },
        { sessionKey: external ? "hook:webhook:cli-monitor" : "cron:cli-monitor" },
      );
      expect(result.status).toBe("ok");
      expect(h.runCliAgentMock).toHaveBeenCalledOnce();
      const runRequest = h.runCliAgentMock.mock.calls[0]?.[0];
      if (external) {
        expect(runRequest.userTurnTranscriptRecorder.message?.provenance).toBeUndefined();
      } else {
        const sessionKey = "agent:default:cron:cli-monitor:run:isolated-cli-run-1";
        expect(result.sessionKey).toBe(sessionKey);
        expect(runRequest).toMatchObject({
          sessionId: "isolated-cli-run-1",
          sessionKey,
          bootstrapContextMode: "lightweight",
          bootstrapContextRunKind: "cron",
          cleanupCliLiveSessionOnRunEnd: true,
        });
        expect(runRequest.sessionTarget).toEqual(
          sessionTarget("isolated-cli-run-1", sessionKey, cronSession.storePath),
        );
        expect(runRequest.sessionKey).not.toBe("agent:default:cron:cli-monitor");
        expect(runRequest.promptCacheKey).toBeUndefined();
        expect(runRequest.cliSessionId).toBeUndefined();
      }
    },
  );
});

const requireRecord = createRequireRecord("record", "expected-label-object");

describe("runCronIsolatedAgentTurn — skill filter", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("persists the selected harness on base and run rows before turn startup fails", async () => {
    const persistedAtStartup = new Map<string, Record<string, unknown>>();
    h.resolveEffectiveAgentRuntimeMock.mockReturnValue("codex");
    h.mockRunCronFallbackPassthrough();
    h.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      for (const [index, result] of h.patchSessionEntryMock.mock.results.entries()) {
        const scope = requireRecord(mockCall(h.patchSessionEntryMock, index)[0], "patch scope");
        const entry = requireRecord(await result.value, "persisted session entry");
        persistedAtStartup.set(String(scope.sessionKey), entry);
      }
      throw new Error("turn/start rejected before result metadata");
    });

    const result = await runJob({}, { agentId: "main" });

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("turn/start rejected before result metadata"),
    });
    expect(await h.patchSessionEntryMock.mock.results[0]?.value).toMatchObject({
      systemSent: true,
      skillsSnapshot: { prompt: "<available_skills></available_skills>", version: 42 },
    });
    for (const key of ["agent:main:cron:test", "agent:main:cron:test:run:test-session-id"]) {
      expect(persistedAtStartup.get(key)).toMatchObject({
        sessionId: "test-session-id",
        agentHarnessId: "codex",
      });
    }
  });

  it("reuses cached snapshot when version and normalized skillFilter are unchanged", async () => {
    h.resolveAgentSkillsFilterMock.mockReturnValue([" weather ", "meme-factory", "weather"]);
    h.resolveCronSessionMock.mockReturnValue(
      makeSession({
        skillsSnapshot: {
          prompt: "<available_skills><skill>weather</skill></available_skills>",
          skills: [{ name: "weather" }],
          skillFilter: ["meme-factory", "weather"],
          version: 42,
        },
      }),
    );

    expect(await runJob()).toMatchObject({ status: "ok" });
    expect(h.buildWorkspaceSkillSnapshotMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "anthropic/claude-sonnet-4-6",
      "model not allowed: anthropic/claude-sonnet-4-6",
      "automation model override 'anthropic/claude-sonnet-4-6' rejected by agents.defaults.modelPolicy.allow: anthropic/claude-sonnet-4-6 is not in [openai/gpt-5.4]",
    ],
    [
      "openai/",
      "invalid model: openai/",
      "automation model override 'openai/' rejected: invalid model: openai/",
    ],
  ])("rejects payload model %s before execution", async (model, error, expected) => {
    h.resolveAllowedModelRefMock.mockReturnValueOnce({ error });
    const result = await runJob(
      { payload: { kind: "agentTurn", message: "test", model } },
      { cfg: { agents: { defaults: { modelPolicy: { allow: ["openai/gpt-5.4"] } } } } },
    );
    expect(result).toMatchObject({ status: "error", error: expected });
    expect(result.diagnostics?.entries).toEqual([
      expect.objectContaining({ source: "cron-preflight", severity: "error", message: expected }),
    ]);
    expect(h.logWarnMock).not.toHaveBeenCalled();
    expect(h.runWithModelFallbackMock).not.toHaveBeenCalled();
  });

  it("passes the cron abort signal to CLI runs and drops late CLI results", async () => {
    const abortController = new AbortController();
    const cliStarted = createDeferred();
    h.runCliAgentMock.mockImplementationOnce(async (params: { abortSignal?: AbortSignal }) => {
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
    h.isCliProviderMock.mockReturnValue(true);
    h.runWithModelFallbackMock.mockImplementationOnce(async (params) => ({
      result: await runInitialModelFallbackAttempt(params, "claude-cli", "claude-opus-4-6"),
      provider: "claude-cli",
      model: "claude-opus-4-6",
      attempts: [],
    }));

    const runPromise = runJob({}, { abortSignal: abortController.signal });
    await cliStarted.promise;
    abortController.abort("cron: job execution timed out");

    const result = await runPromise;

    expect(result).toMatchObject({ status: "error", error: "cron: job execution timed out" });
    expect(h.dispatchCronDeliveryMock).not.toHaveBeenCalled();
  });
  it.each([
    [true, false, 1_000_000, "runtime"],
    [false, false, 222_000, "runtime"],
    [false, true, 222_000, undefined],
  ] as const)(
    "persists context provenance (reported=%s, locked=%s)",
    async (reported, locked, expected, source) => {
      const session = makeSession({
        modelProvider: "openai",
        model: "gpt-5.4",
        agentHarnessId: reported ? "openclaw" : "codex",
        contextTokens: 222_000,
        contextTokensSource: locked ? undefined : reported ? "resolved" : "runtime",
        modelSelectionLocked: locked,
      });
      h.resolveCronSessionMock.mockReturnValue(session);
      h.lookupModelContextTokensMock.mockReturnValue(512_000);
      h.resolveEffectiveAgentRuntimeMock.mockReturnValue("codex");
      h.mockRunCronFallbackPassthrough();
      h.runEmbeddedAgentMock.mockResolvedValueOnce({
        payloads: [{ text: "test output" }],
        meta: {
          agentMeta: {
            provider: "openai",
            model: "gpt-5.4",
            agentHarnessId: "codex",
            ...(reported ? { contextTokens: 1_000_000, contextTokensSource: "runtime" } : {}),
          },
        },
      });
      expect((await runJob()).status).toBe("ok");
      expect(session.sessionEntry).toMatchObject({
        agentHarnessId: "codex",
        contextTokens: expected,
        contextTokensSource: source,
      });
    },
  );
});

it("canonicalizes agent:id:main alias to configured mainKey (#29683)", () => {
  expect(
    resolveCronAgentSessionKey({
      sessionKey: "agent:ops:main",
      agentId: "ops",
      mainKey: "work",
      cfg: { session: { mainKey: "work" } },
    }),
  ).toBe("agent:ops:work");
});
