import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { appendTranscriptMessageSync } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../infra/diagnostic-events.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  diagnosticLogger,
  logSessionStateChange,
  startGatewayDiagnosticHeartbeat,
} from "./diagnostic.js";
import { resetDiagnosticStateForTest } from "./diagnostic.test-support.js";

let state: OpenClawTestState;
let diagnosticsEnabled: boolean;
let clock: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
const reply = "synthetic current assistant reply";
const privateReply = "synthetic memory-only assistant reply";
const incognitoKey = "agent:heartbeat:dashboard:incognito-private";

beforeAll(async () => {
  diagnosticsEnabled = areDiagnosticsEnabledForProcess();
  state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-heartbeat-context-",
  });
  for (const label of ["enabled", "disabled", "incognito"]) {
    const incognito = label === "incognito";
    const scope = {
      agentId: "heartbeat",
      sessionKey: incognito ? incognitoKey : `agent:heartbeat:${label}`,
      sessionId: `heartbeat-${label}`,
    };
    replaceSessionEntrySync(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      ...(incognito ? { incognito: true } : {}),
    });
    appendTranscriptMessageSync(scope, {
      message: { role: "assistant", content: incognito ? privateReply : reply },
    });
  }
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock = createGatewaySchedulerClock(Date.now());
  scheduler = createTestGatewayScheduler(clock.clock);
  resetDiagnosticStateForTest();
  setDiagnosticsEnabledForProcess(true);
  vi.spyOn(diagnosticLogger, "isEnabled").mockReturnValue(true);
});

afterEach(async () => {
  resetDiagnosticStateForTest();
  await scheduler.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterAll(async () => {
  await state.cleanup();
  setDiagnosticsEnabledForProcess(diagnosticsEnabled);
});

async function tick() {
  vi.setSystemTime(clock.clock.now() + 30_000);
  await clock.advanceBy(30_000);
}

it.each([true, false])(
  "keeps heartbeat enrichment off the main thread with its sink enabled=%s",
  async (enabled) => {
    vi.mocked(diagnosticLogger.isEnabled).mockReturnValue(enabled);
    const label = enabled ? "enabled" : "disabled";
    const sessionId = `heartbeat-${label}`;
    const sessionKey = `agent:heartbeat:${label}`;
    const logged = createDeferred();
    const warn = vi.spyOn(diagnosticLogger, "warn").mockImplementation((message) => {
      if (message.startsWith(`stuck session: sessionId=${sessionId} `)) {
        logged.resolve();
      }
    });
    const recover = vi.fn();
    startGatewayDiagnosticHeartbeat(
      scheduler,
      {},
      {
        testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs: 60_000 },
        sampleLiveness: () => null,
        recoverStuckSession: recover,
      },
    );
    logSessionStateChange({ sessionId, sessionKey, state: "processing" });
    const queries = [
      vi.spyOn(DatabaseSync.prototype, "prepare"),
      vi.spyOn(DatabaseSync.prototype, "exec"),
      vi.spyOn(StatementSync.prototype, "get"),
      vi.spyOn(StatementSync.prototype, "all"),
      vi.spyOn(StatementSync.prototype, "iterate"),
      vi.spyOn(StatementSync.prototype, "run"),
    ];
    try {
      await tick();
      await tick();
      expect(recover).toHaveBeenCalled();
      if (enabled) {
        await logged.promise;
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`lastAssistant="${reply}"`));
      } else {
        expect(warn).not.toHaveBeenCalled();
      }
      for (const query of queries) {
        expect(query).not.toHaveBeenCalled();
      }
    } finally {
      for (const query of queries) {
        query.mockRestore();
      }
    }
  },
);

it("never copies an incognito reply into durable heartbeat diagnostics", async () => {
  const warn = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => {});
  startGatewayDiagnosticHeartbeat(
    scheduler,
    {},
    {
      testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs: 60_000 },
      sampleLiveness: () => null,
      recoverStuckSession: vi.fn(),
    },
  );
  logSessionStateChange({
    sessionId: "heartbeat-incognito",
    sessionKey: incognitoKey,
    state: "processing",
  });
  await tick();
  await tick();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining(`sessionKey=${incognitoKey}`));
  for (const [message] of warn.mock.calls) {
    expect(message).not.toContain(privateReply);
    expect(message).not.toContain("lastAssistant=");
  }
});
