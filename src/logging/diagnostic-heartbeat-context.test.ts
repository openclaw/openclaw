import { channel } from "node:diagnostics_channel";
import fs from "node:fs/promises";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import {
  areDiagnosticsEnabledForProcess,
  onDiagnosticEvent,
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
import type { EmitDiagnosticMemorySample } from "./diagnostic-memory.js";
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
const heartbeatOptions = {
  testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs: 60_000 },
  sampleLiveness: () => null,
};
function session(label: string) {
  return {
    agentId: "heartbeat",
    sessionId: `heartbeat-${label}`,
    sessionKey: label === "incognito" ? incognitoKey : `agent:heartbeat:${label}`,
  };
}

beforeAll(async () => {
  diagnosticsEnabled = areDiagnosticsEnabledForProcess();
  state = await createOpenClawTestState({ layout: "state-only", prefix: "heartbeat-context-" });
  setRuntimeConfigSnapshot({});
  for (const label of ["enabled", "disabled", "incognito"]) {
    const incognito = label === "incognito";
    const scope = session(label);
    await replaceSessionEntry(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      ...(incognito ? { incognito: true } : {}),
    });
    const message = { role: "assistant", content: incognito ? privateReply : reply };
    await appendTranscriptMessage(scope, { message });
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetDiagnosticStateForTest();
  await scheduler.stop();
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
  const emitMemorySample = vi.fn<EmitDiagnosticMemorySample>();
  const options = { ...heartbeatOptions, recoverStuckSession: () => undefined, emitMemorySample };
  startGatewayDiagnosticHeartbeat(scheduler, { diagnostics: { enabled: true } }, options);

  for (const emitSample of [false, true]) {
    if (emitSample) {
      logSessionStateChange({ ...session("samples"), state: "processing" });
    }
    await tick();
    expect(emitMemorySample).toHaveBeenLastCalledWith({ emitSample });
    expect(emitMemorySample.mock.contexts.at(-1)).toBe(options);
  }
});

it("keeps recovery and pressure checks running while a Linux footprint read is pending", async () => {
  vi.stubGlobal("process", Object.create(process, { platform: { value: "linux" } }));
  const footprint = createDeferred<string>();
  const sampled = createDeferred();
  const readFile = vi.spyOn(fs, "readFile").mockReturnValue(footprint.promise);
  const memory = process.memoryUsage();
  vi.spyOn(process, "memoryUsage").mockReturnValue({ ...memory, rss: Number.MAX_SAFE_INTEGER });
  const critical = vi.fn();
  const pressure = channel("openclaw.memory.critical");
  pressure.subscribe(critical);
  const stop = onDiagnosticEvent((event) => {
    if (event.type === "diagnostic.memory.sample") {
      sampled.resolve();
    }
  });
  const recover = vi.fn();
  startGatewayDiagnosticHeartbeat(
    scheduler,
    {},
    { ...heartbeatOptions, recoverStuckSession: recover },
  );
  logSessionStateChange({ ...session("pending-footprint"), state: "processing" });
  const first = tick();
  const second = tick();
  try {
    expect(recover).toHaveBeenCalled();
    expect(critical).toHaveBeenCalledTimes(2);
    expect(readFile).toHaveBeenCalledTimes(1);
  } finally {
    footprint.resolve("RssAnon:\t1234 kB\nVmSwap:\t0 kB\n");
    await Promise.all([first, second, sampled.promise]);
    stop();
    pressure.unsubscribe(critical);
  }
});

it.each(["enabled", "disabled", "incognito"])(
  "keeps %s heartbeat diagnostics off the main thread and excludes reply content",
  async (label) => {
    const enabled = label !== "disabled";
    vi.mocked(diagnosticLogger.isEnabled).mockReturnValue(enabled);
    const { sessionId, sessionKey } = session(label);
    const logged = createDeferred();
    const warn = vi.spyOn(diagnosticLogger, "warn").mockImplementation((message) => {
      if (message.startsWith(`stuck session: sessionId=${sessionId} `)) {
        logged.resolve();
      }
    });
    const recover = vi.fn();
    const options = { ...heartbeatOptions, recoverStuckSession: recover };
    startGatewayDiagnosticHeartbeat(scheduler, {}, options);
    logSessionStateChange({ sessionId, sessionKey, state: "processing" });
    const queries = [
      ...(["prepare", "exec"] as const).map((method) => vi.spyOn(DatabaseSync.prototype, method)),
      ...(["get", "all", "iterate", "run"] as const).map((method) =>
        vi.spyOn(StatementSync.prototype, method),
      ),
    ];
    await tick();
    await tick();
    expect(recover).toHaveBeenCalled();
    if (enabled && label !== "incognito") {
      await logged.promise;
      for (const identity of [`sessionId=${sessionId}`, `sessionKey=${sessionKey}`]) {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(identity));
      }
    } else {
      expect(warn).not.toHaveBeenCalled();
    }
    for (const content of [label === "incognito" ? privateReply : reply, "lastAssistant="]) {
      expect(JSON.stringify(warn.mock.calls)).not.toContain(content);
    }
    for (const query of queries) {
      expect(query).not.toHaveBeenCalled();
    }
  },
);
