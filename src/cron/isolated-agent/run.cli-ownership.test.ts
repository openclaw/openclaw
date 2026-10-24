import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  abortEmbeddedAgentRun,
  isEmbeddedAgentRunHandleActive,
} from "../../agents/embedded-agent-runner/runs.js";
import type { CliSessionBinding } from "../../config/sessions.js";
import type { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import * as harness from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await harness.loadRunCronIsolatedAgentTurn();

const sessionId = "cron-cli-diagnostic-session";

function makeCliOwnershipParams() {
  return makeIsolatedAgentParamsFixture({
    job: makeIsolatedAgentJobFixture({
      sessionTarget: "session:existing-cron-session",
      payload: { kind: "agentTurn", message: "summarize", model: "test-cli/test-model" },
    }),
    message: "summarize",
    sessionKey: "existing-cron-session",
  });
}

describe("cron project: runCronIsolatedAgentTurn CLI ownership", () => {
  let cronSession: ReturnType<typeof harness.makeCronSession>;
  setupRunCronIsolatedAgentTurnSuite();
  beforeEach(() => {
    harness.isCliProviderMock.mockImplementation((provider: string) => provider === "test-cli");
    const ref = { provider: "test-cli", model: "test-model" };
    harness.resolveConfiguredModelRefMock.mockReturnValue(ref);
    harness.resolveAllowedModelRefMock.mockReturnValue({ ref });
    harness.resolveThinkingDefaultMock.mockReturnValue("off");
    cronSession = harness.makeCronSession({
      sessionEntry: harness.makeCronSessionEntry({ sessionId }),
      isNewSession: true,
    });
    harness.resolveCronSessionMock.mockReturnValue(cronSession);
    harness.mockRunCronFallbackPassthrough();
  });

  it.each([
    { outcome: "accepted", abort: false },
    { outcome: "canceled", abort: true },
  ])("holds ownership during a pending continuity write ($outcome)", async ({ abort }) => {
    const writeStarted = createDeferred();
    const releaseWrite = createDeferred();
    const upstream = new AbortController();
    const binding: CliSessionBinding = {
      sessionId: "native-cli-session",
      reseedReceipt: {
        version: 1,
        promptHash: "a".repeat(64),
        localSessionId: sessionId,
        userTurnDisposition: "persisted",
      },
    };
    const persist = expectDefined(harness.patchSessionEntryMock.getMockImplementation(), "persist");
    let continuityCommitted = false;
    const holdContinuityWrite: typeof patchSessionEntryCore = async (scope, update, options) => {
      const assertCurrent = expectDefined(options?.workerGuard?.assertCurrent, "commit guard");
      writeStarted.resolve();
      await releaseWrite.promise;
      assertCurrent();
      const committed = await persist(scope, update, options);
      continuityCommitted = true;
      return committed;
    };
    harness.runCliAgentMock.mockImplementationOnce(async (params) => {
      expect(params.diagnosticOwner).toMatchObject({ sessionId, generation: expect.anything() });
      expect(params.abortSignal).toBeInstanceOf(AbortSignal);
      expect(params.abortSignal.aborted).toBe(false);
      expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(true);
      harness.patchSessionEntryMock.mockImplementationOnce(holdContinuityWrite);
      return {
        payloads: [{ text: "summary done" }],
        meta: {
          executionTrace: { runner: "cli" },
          agentMeta: { provider: "test-cli", model: "test-model", cliSessionBinding: binding },
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
    harness.runCliAgentMock.mockImplementationOnce(async (params) => {
      expect(params.abortSignal.aborted).toBe(false);
      expect(abortEmbeddedAgentRun(sessionId)).toBe(true);
      expect(params.abortSignal.aborted).toBe(true);
      throw Object.assign(new Error("CLI run aborted"), { name: "AbortError" });
    });

    const result = await runCronIsolatedAgentTurn(makeCliOwnershipParams());

    expect(result).toMatchObject({
      status: "error",
      error: "agent run aborted | OPENCLAW_DIRECT_ABORT",
    });
    expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(false);
  });
});
