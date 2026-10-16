import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../infra/diagnostic-events.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
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
  setRuntimeConfigSnapshot({});
  for (const label of ["enabled", "disabled", "incognito"]) {
    const incognito = label === "incognito";
    const scope = {
      agentId: "heartbeat",
      sessionKey: incognito ? incognitoKey : `agent:heartbeat:${label}`,
      sessionId: `heartbeat-${label}`,
    };
    await replaceSessionEntry(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      ...(incognito ? { incognito: true } : {}),
    });
    await appendTranscriptMessage(scope, {
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
  memorySessionActorOwners.closeDatabase({
    agentId: "heartbeat",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "heartbeat", env: state.env }),
  });
  await state.cleanup();
  setDiagnosticsEnabledForProcess(diagnosticsEnabled);
});

async function tick() {
  vi.setSystemTime(clock.clock.now() + 30_000);
  await clock.advanceBy(30_000);
}

it("checks memory pressure every tick without recording idle samples", async () => {
  const emitMemorySample = vi.fn(() => ({
    rssBytes: 100,
    heapTotalBytes: 80,
    heapUsedBytes: 40,
    externalBytes: 10,
    arrayBuffersBytes: 5,
  }));
  const options = {
    testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs: 60_000 },
    recoverStuckSession: () => undefined,
    emitMemorySample,
    sampleLiveness: () => null,
  };
  startGatewayDiagnosticHeartbeat(scheduler, { diagnostics: { enabled: true } }, options);

  await tick();
  expect(emitMemorySample).toHaveBeenLastCalledWith({ emitSample: false });
  expect(emitMemorySample.mock.contexts.at(-1)).toBe(options);

  logSessionStateChange({
    sessionId: "heartbeat-samples",
    sessionKey: "agent:heartbeat:samples",
    state: "processing",
  });
  await tick();

  expect(emitMemorySample).toHaveBeenLastCalledWith({ emitSample: true });
  expect(emitMemorySample.mock.contexts.at(-1)).toBe(options);
});

it.each(["enabled", "disabled", "incognito"])(
  "keeps %s heartbeat diagnostics off the main thread and excludes reply content",
  async (label) => {
    const enabled = label !== "disabled";
    vi.mocked(diagnosticLogger.isEnabled).mockReturnValue(enabled);
    const sessionId = `heartbeat-${label}`;
    const sessionKey = label === "incognito" ? incognitoKey : `agent:heartbeat:${label}`;
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
      ...(["prepare", "exec"] as const).map((method) => vi.spyOn(DatabaseSync.prototype, method)),
      ...(["get", "all", "iterate", "run"] as const).map((method) =>
        vi.spyOn(StatementSync.prototype, method),
      ),
    ];
    try {
      await tick();
      await tick();
      expect(recover).toHaveBeenCalled();
      if (enabled) {
        await logged.promise;
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`sessionId=${sessionId}`));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`sessionKey=${sessionKey}`));
        expect(JSON.stringify(warn.mock.calls)).not.toContain(
          label === "incognito" ? privateReply : reply,
        );
        expect(JSON.stringify(warn.mock.calls)).not.toContain("lastAssistant=");
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
