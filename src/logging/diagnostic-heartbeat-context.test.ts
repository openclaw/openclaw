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
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { diagnosticLogger, logSessionStateChange, startDiagnosticHeartbeat } from "./diagnostic.js";
import { resetDiagnosticStateForTest } from "./diagnostic.test-support.js";

let state: OpenClawTestState;
let diagnosticsEnabled: boolean;
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
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  resetDiagnosticStateForTest();
  setDiagnosticsEnabledForProcess(true);
  vi.spyOn(diagnosticLogger, "isEnabled").mockReturnValue(true);
});

afterEach(() => {
  resetDiagnosticStateForTest();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterAll(async () => {
  await state.cleanup();
  setDiagnosticsEnabledForProcess(diagnosticsEnabled);
});

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
    startDiagnosticHeartbeat(
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
      vi.advanceTimersByTime(61_000);
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

it("never copies an incognito reply into durable heartbeat diagnostics", () => {
  const warn = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => {});
  startDiagnosticHeartbeat(
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
  vi.advanceTimersByTime(61_000);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining(`sessionKey=${incognitoKey}`));
  for (const [message] of warn.mock.calls) {
    expect(message).not.toContain(privateReply);
    expect(message).not.toContain("lastAssistant=");
  }
});
