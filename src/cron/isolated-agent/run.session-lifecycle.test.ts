// Persistent cron session tests cover lifecycle admission and mutation races.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  interruptSessionWorkAdmissions,
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import {
  dispatchCronDeliveryMock,
  loadRunCronIsolatedAgentTurn,
  loadSessionEntryMock,
  callGatewayMock,
  makeCronSession,
  makeCronSessionEntry,
  mockRunCronFallbackPassthrough,
  patchSessionEntryMock,
  preflightCronModelProviderMock,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const inMemoryStorePath = "/tmp/store.json";

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makePersistentCronParams(sessionKey: string) {
  return makeIsolatedAgentParamsFixture({
    agentId: "main",
    sessionKey,
    job: makeIsolatedAgentJobFixture({
      // Bind the run to the persistent session key so the run operates on it
      // directly; `current`/`isolated` targets derive a detached `cron:<id>`
      // run session instead, which the lifecycle claim assertions do not target.
      sessionTarget: `session:${sessionKey}`,
      delivery: { mode: "none" },
    }),
  });
}

describe("runCronIsolatedAgentTurn session lifecycle", () => {
  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
    mockRunCronFallbackPassthrough();
  });

  it("rejects a session that rotates during async setup", async () => {
    const sessionKey = "agent:main:main";
    const initialSessionEntry = makeCronSessionEntry({
      sessionId: "session-before-setup",
    });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath: inMemoryStorePath,
        store: { [sessionKey]: { ...initialSessionEntry } },
        initialSessionEntry,
        isNewSession: false,
        sessionEntry: { ...initialSessionEntry },
      }),
    );
    loadSessionEntryMock.mockReturnValue({
      ...initialSessionEntry,
      sessionId: "session-after-setup",
    });
    const releasePreflight = createDeferred();
    preflightCronModelProviderMock.mockImplementationOnce(async () => {
      await releasePreflight.promise;
      return { status: "available" };
    });

    const run = runCronIsolatedAgentTurn(makePersistentCronParams(sessionKey));
    await vi.waitFor(() => expect(preflightCronModelProviderMock).toHaveBeenCalledTimes(1));
    releasePreflight.resolve();

    await expect(run).rejects.toThrow(
      `Session "${sessionKey}" changed while starting work. Retry.`,
    );
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("allows a rename and unpin during async setup", async () => {
    const sessionKey = "agent:main:main";
    const initialSessionEntry = makeCronSessionEntry({
      label: "before setup",
      pinnedAt: 1,
      sessionId: "same-session",
      updatedAt: 1,
    });
    const currentSessionEntry = {
      ...initialSessionEntry,
      label: "patched during setup",
      pinnedAt: undefined,
      updatedAt: 2,
    };
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath: inMemoryStorePath,
        store: { [sessionKey]: { ...currentSessionEntry } },
        initialSessionEntry,
        isNewSession: false,
        sessionEntry: { ...initialSessionEntry },
      }),
    );
    loadSessionEntryMock.mockReturnValue(currentSessionEntry);
    const releasePreflight = createDeferred();
    preflightCronModelProviderMock.mockImplementationOnce(async () => {
      await releasePreflight.promise;
      return { status: "available" };
    });

    const run = runCronIsolatedAgentTurn(makePersistentCronParams(sessionKey));
    await vi.waitFor(() => expect(preflightCronModelProviderMock).toHaveBeenCalledTimes(1));
    releasePreflight.resolve();

    await expect(run).resolves.toMatchObject({ status: "ok" });
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
  });

  it("interrupts persistent cron work and waits for its lifecycle lease to release", async () => {
    const sessionKey = "agent:main:telegram:direct:42";
    const sessionId = "shared-session";
    const storePath = inMemoryStorePath;
    const initialSessionEntry = makeCronSessionEntry({ sessionId });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath,
        store: { [sessionKey]: { ...initialSessionEntry } },
        initialSessionEntry,
        isNewSession: false,
        sessionEntry: { ...initialSessionEntry },
      }),
    );
    loadSessionEntryMock.mockReturnValue({ ...initialSessionEntry });
    const runnerStarted = createDeferred();
    const lifecycleInterrupted = createDeferred();
    const releaseRunner = createDeferred();
    runEmbeddedAgentMock.mockImplementationOnce(
      async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
        runnerStarted.resolve();
        if (abortSignal?.aborted) {
          lifecycleInterrupted.resolve();
        } else {
          abortSignal?.addEventListener("abort", lifecycleInterrupted.resolve, {
            once: true,
          });
        }
        await releaseRunner.promise;
        return {
          payloads: [],
          meta: { aborted: true, agentMeta: {} },
        };
      },
    );

    const run = runCronIsolatedAgentTurn(makePersistentCronParams(sessionKey));
    await runnerStarted.promise;
    let mutationCommitted = false;
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      prepare: async () => {
        await interruptSessionWorkAdmissions({
          scope: storePath,
          identities: [sessionKey, sessionId],
        });
      },
      run: async () => {
        mutationCommitted = true;
      },
    });

    await lifecycleInterrupted.promise;
    expect(mutationCommitted).toBe(false);
    releaseRunner.resolve();

    const [result] = await Promise.all([run, mutation]);
    expect(result).toEqual(
      expect.objectContaining({
        status: "error",
        error: "agent run aborted for restart",
      }),
    );
    expect(mutationCommitted).toBe(true);
  });

  it("releases an isolated run lease before delete-after-run cleanup", async () => {
    const sessionKey = "agent:main:cron:test-job";
    const sessionId = "isolated-session";
    const storePath = inMemoryStorePath;
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath,
        initialSessionEntry: undefined,
        isNewSession: true,
        sessionEntry: makeCronSessionEntry({ sessionId }),
      }),
    );
    loadSessionEntryMock.mockReturnValue(undefined);
    let admissionActiveDuringDelete = true;
    callGatewayMock.mockImplementationOnce(async () => {
      admissionActiveDuringDelete = isSessionWorkAdmissionActive(storePath, [
        sessionKey,
        sessionId,
      ]);
      return { ok: true, deleted: true };
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        agentId: "main",
        sessionKey: "cron:test-job",
        job: makeIsolatedAgentJobFixture({
          sessionTarget: "isolated",
          deleteAfterRun: true,
          delivery: { mode: "none" },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(admissionActiveDuringDelete).toBe(false);
  });

  it("keeps a non-deleting isolated run admitted through delivery", async () => {
    const sessionKey = "agent:main:cron:test-job";
    const sessionId = "isolated-session";
    const storePath = inMemoryStorePath;
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath,
        initialSessionEntry: undefined,
        isNewSession: true,
        sessionEntry: makeCronSessionEntry({ sessionId }),
      }),
    );
    loadSessionEntryMock.mockReturnValue(undefined);
    const deliveryStarted = createDeferred();
    const releaseDelivery = createDeferred();
    dispatchCronDeliveryMock.mockImplementationOnce(async ({ deliveryPayloads }) => {
      deliveryStarted.resolve();
      await releaseDelivery.promise;
      return {
        delivered: false,
        deliveryAttempted: false,
        deliveryPayloads,
      };
    });

    const run = runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        agentId: "main",
        sessionKey: "cron:test-job",
        job: makeIsolatedAgentJobFixture({
          sessionTarget: "isolated",
          deleteAfterRun: false,
          delivery: { mode: "none" },
        }),
      }),
    );
    await deliveryStarted.promise;
    expect(isSessionWorkAdmissionActive(storePath, [sessionKey, sessionId])).toBe(true);
    releaseDelivery.resolve();

    await expect(run).resolves.toMatchObject({ status: "ok" });
    expect(isSessionWorkAdmissionActive(storePath, [sessionKey, sessionId])).toBe(false);
  });

  it("marks a final lifecycle claim conflict as post-execution (#108428)", async () => {
    const sessionKey = "agent:main:main";
    const initialSessionEntry = makeCronSessionEntry({
      sessionId: "persistent-session",
    });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath: inMemoryStorePath,
        store: { [sessionKey]: { ...initialSessionEntry } },
        initialSessionEntry,
        isNewSession: false,
        sessionEntry: { ...initialSessionEntry },
      }),
    );
    loadSessionEntryMock.mockReturnValue({ ...initialSessionEntry });

    let agentExecutionStarted = false;
    runEmbeddedAgentMock.mockImplementationOnce(
      async (runParams: { onExecutionStarted?: () => void }) => {
        runParams.onExecutionStarted?.();
        agentExecutionStarted = true;
        return {
          payloads: [{ text: "completed" }],
          meta: { agentMeta: {} },
        };
      },
    );

    const committedRows = new Map<string, SessionEntry>([
      [`${inMemoryStorePath}\0${sessionKey}`, structuredClone(initialSessionEntry) as SessionEntry],
    ]);
    patchSessionEntryMock.mockImplementation(
      async (
        scope: { storePath?: string; sessionKey: string },
        update: (
          entry: SessionEntry,
          context: { existingEntry: SessionEntry | undefined },
        ) => SessionEntry | null,
        options: { fallbackEntry?: SessionEntry } = {},
      ) => {
        const key = `${scope.storePath ?? ""}\0${scope.sessionKey}`;
        const current = committedRows.get(key);
        const writeBase = current ?? options.fallbackEntry;
        if (!writeBase) {
          return null;
        }
        const existingEntry =
          agentExecutionStarted && scope.sessionKey === sessionKey
            ? { ...writeBase, lifecycleRevision: "replacement-revision" }
            : current;
        const committed = update(structuredClone(writeBase), {
          existingEntry: existingEntry ? structuredClone(existingEntry) : undefined,
        });
        if (committed) {
          committedRows.set(key, structuredClone(committed));
        }
        return committed;
      },
    );

    await expect(
      runCronIsolatedAgentTurn(makePersistentCronParams(sessionKey)),
    ).resolves.toMatchObject({
      status: "error",
      error: `CronSessionLifecycleClaimError: Session "${sessionKey}" changed while starting work. Retry.`,
      executionStarted: true,
    });
  });

  it("keeps hook-reset cron sessions after embedded runs return stale metadata", async () => {
    const stableSessionKey = "agent:main:cron:budget-reset";
    const runSessionKey = `${stableSessionKey}:run:session-before-reset`;
    const initialSessionEntry = makeCronSessionEntry({
      sessionId: "session-before-reset",
      sessionFile: "/tmp/session-before-reset.jsonl",
      compactionCount: 9,
    });
    const resetEntry = makeCronSessionEntry({
      sessionId: "session-after-reset",
      sessionFile: "sqlite:main:session-after-reset:/tmp/store.json",
      compactionCount: 0,
    });
    const latestRows = new Map<string, SessionEntry>();
    const cronSession = makeCronSession({
      storePath: inMemoryStorePath,
      store: {},
      initialSessionEntry: undefined,
      isNewSession: true,
      sessionEntry: { ...initialSessionEntry },
    });
    resolveCronSessionMock.mockReturnValue(cronSession);
    loadSessionEntryMock.mockImplementation((_storePath: string, key: string) =>
      latestRows.get(key),
    );
    let sessionEntryAfterResetCallback: string | undefined;
    runEmbeddedAgentMock.mockImplementationOnce(
      async (runParams: {
        sessionKey?: string;
        onSessionResetCommitted?: (commit: {
          key: string;
          sessionId: string;
          reason: "new" | "reset";
        }) => void;
      }) => {
        expect(runParams.sessionKey).toBe(runSessionKey);
        latestRows.set(runSessionKey, structuredClone(resetEntry) as SessionEntry);
        runParams.onSessionResetCommitted?.({
          key: runSessionKey,
          sessionId: "session-after-reset",
          reason: "new",
        });
        sessionEntryAfterResetCallback = cronSession.sessionEntry.sessionId;
        return {
          payloads: [{ text: "completed" }],
          meta: {
            agentMeta: {
              sessionId: "session-stale-compacted",
              sessionFile: "/tmp/session-stale-compacted.jsonl",
              compactionCount: 10,
              usage: { input: 1, output: 1 },
              lastCallUsage: { input: 2, output: 2, total: 4 },
            },
          },
        };
      },
    );

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        agentId: "main",
        sessionKey: "cron:budget-reset",
        job: makeIsolatedAgentJobFixture({
          id: "budget-reset",
          sessionTarget: "isolated",
          delivery: { mode: "none" },
        }),
      }),
    );

    expect(result).toMatchObject({
      status: "ok",
      sessionId: "session-after-reset",
      sessionKey: runSessionKey,
    });

    expect(sessionEntryAfterResetCallback).toBe("session-after-reset");
    expect(cronSession.sessionEntry).toMatchObject({
      sessionId: "session-after-reset",
      sessionFile: "sqlite:main:session-after-reset:/tmp/store.json",
      compactionCount: 0,
    });
    expect(cronSession.sessionEntry.inputTokens).toBeUndefined();
    expect(cronSession.sessionEntry.outputTokens).toBeUndefined();
    expect(cronSession.sessionEntry.totalTokens).toBeUndefined();
    expect(cronSession.sessionEntry.totalTokensFresh).toBeUndefined();
    const stableSessionWrites = patchSessionEntryMock.mock.calls.filter(
      (call) => (call[0] as { sessionKey: string }).sessionKey === stableSessionKey,
    );
    const finalStableWriteOptions = stableSessionWrites.at(-1)?.[2] as
      | { fallbackEntry?: SessionEntry }
      | undefined;
    expect(finalStableWriteOptions?.fallbackEntry).toMatchObject({
      sessionId: "session-after-reset",
      sessionFile: "sqlite:main:session-after-reset:/tmp/store.json",
      compactionCount: 0,
    });
    expect(finalStableWriteOptions?.fallbackEntry?.inputTokens).toBeUndefined();
    expect(finalStableWriteOptions?.fallbackEntry?.outputTokens).toBeUndefined();
    expect(finalStableWriteOptions?.fallbackEntry?.totalTokens).toBeUndefined();
    expect(finalStableWriteOptions?.fallbackEntry?.totalTokensFresh).toBeUndefined();
  });

  it("releases a custom cron session lease before delete-after-run cleanup", async () => {
    const sessionKey = "agent:main:cron:cleanup";
    const sessionId = "custom-cron-session";
    const storePath = inMemoryStorePath;
    const initialSessionEntry = makeCronSessionEntry({ sessionId });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath,
        store: { [sessionKey]: { ...initialSessionEntry } },
        initialSessionEntry,
        isNewSession: false,
        sessionEntry: { ...initialSessionEntry },
      }),
    );
    loadSessionEntryMock.mockReturnValue({ ...initialSessionEntry });
    let admissionActiveDuringDelete = true;
    callGatewayMock.mockImplementationOnce(async () => {
      admissionActiveDuringDelete = isSessionWorkAdmissionActive(storePath, [
        sessionKey,
        sessionId,
      ]);
      return { ok: true, deleted: true };
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        agentId: "main",
        sessionKey,
        job: makeIsolatedAgentJobFixture({
          sessionTarget: `session:${sessionKey}`,
          deleteAfterRun: true,
          delivery: { mode: "none" },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(admissionActiveDuringDelete).toBe(false);
  });
});
