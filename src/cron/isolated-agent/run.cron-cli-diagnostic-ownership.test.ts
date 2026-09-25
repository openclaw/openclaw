import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  abortEmbeddedAgentRun,
  isEmbeddedAgentRunHandleActive,
} from "../../agents/embedded-agent-runner/runs.js";
import type { CliSessionBinding } from "../../config/sessions.js";
import type { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { RunCronAgentTurnParams } from "./run-prepare-runtime.js";
import {
  clearFastTestEnv,
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  mockRunCronFallbackPassthrough,
  patchSessionEntryMock,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  resolveCronSessionMock,
  resolveThinkingDefaultMock,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
  runCliAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const sessionId = "cron-cli-diagnostic-session";

function makeParams(): RunCronAgentTurnParams {
  return {
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
    sessionKey: "cron:cli-diagnostic",
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
        options?.assertCommitAllowed,
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

    const runPromise = runCronIsolatedAgentTurn({ ...makeParams(), abortSignal: upstream.signal });
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

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("error");
    expect(result.error).toBe("agent run aborted | OPENCLAW_DIRECT_ABORT");
    expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(false);
  });
});
