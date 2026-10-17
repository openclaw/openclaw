import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  areDiagnosticsEnabledForProcess,
  onTrustedInternalDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import {
  measureDiagnosticsTimelineSpan as measureSpan,
  measureDiagnosticsTimelineSpanSync as measureSpanSync,
  withDiagnosticsTimelineObserver as observeTimeline,
} from "../../infra/diagnostics-timeline.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { startChatSendDiagnostics } from "./chat-send-diagnostics.js";

let previousDiagnostics: boolean;
let clock: number;
function createDiagnostics(info = vi.fn()) {
  return { info, diagnostics: startChatSendDiagnostics({ info }) };
}
function expectLog(info: ReturnType<typeof vi.fn>, message: string) {
  expect(info).toHaveBeenCalledExactlyOnceWith(message);
}
function at(time: number, action?: () => unknown) {
  clock = time;
  return action?.();
}
beforeEach(() => {
  previousDiagnostics = areDiagnosticsEnabledForProcess();
  setDiagnosticsEnabledForProcess(false);
  clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});
afterEach(() => {
  setDiagnosticsEnabledForProcess(previousDiagnostics);
  vi.restoreAllMocks();
});

test.each([999.9, 1_000])(
  "slow sends remain visible at the 1s threshold with diagnostics disabled (%sms)",
  (elapsedMs) => {
    const { info, diagnostics } = createDiagnostics();
    diagnostics.scope("authority");
    at(elapsedMs, () => diagnostics[Symbol.dispose]());
    if (elapsedMs < 1_000) {
      expect(info).not.toHaveBeenCalled();
    } else {
      expectLog(info, "slow chat send 1000ms stage=request authority=1000ms");
    }
  },
);

test.each(["startup", "steer", "queued"] as const)(
  "acknowledgement splits overlapping phases into request and %s observations",
  async (stage) => {
    setDiagnosticsEnabledForProcess(true);
    const events: DiagnosticEventPayload[] = [];
    const stop = onTrustedInternalDiagnosticEvent((event) => events.push(event), {
      include: ["diagnostic.phase.completed"],
    });
    const { info, diagnostics } = createDiagnostics();
    try {
      const request = diagnostics.scope("persist")!;
      at(10, () => request.mark("response"));
      const snapshot = diagnostics.scope("snapshot")!;
      at(15, request.finish);
      diagnostics.acknowledge(stage === "queued" ? "startup" : stage);
      diagnostics[Symbol.dispose]();
      const parallel = diagnostics.scope("snapshot")!;
      at(815, parallel.finish);
      at(1_215, () => snapshot.mark("dispatch"));
      at(1_415);
      diagnostics.finish({
        isSteered: () => false,
        isEnqueued: () => stage === "queued",
        isTerminal: () => false,
      });
      expect(events).toEqual([]);
      expectLog(
        info,
        `slow chat send 1400ms stage=${stage} ack=15ms snapshot=2000ms dispatch=200ms`,
      );

      at(4_000, () => snapshot.mark("effects"));
      snapshot.finish();
      diagnostics.acknowledge();
      diagnostics.finish();
      expect(diagnostics.scope("worktree")).toBeUndefined();
      await waitForDiagnosticEventsDrained();
      expect(events).toMatchObject([
        { name: "chat.send.persist", durationMs: 10, details: { stage: "request" } },
        { name: "chat.send.snapshot", durationMs: 5, details: { stage: "request" } },
        { name: "chat.send.response", durationMs: 5, details: { stage: "request" } },
        { name: "chat.send.snapshot", durationMs: 2_000, details: { stage } },
        { name: "chat.send.dispatch", durationMs: 200, details: { stage } },
      ]);
      expect(info).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  },
);

test("logging failures preserve the send error and retire unfinished scopes", () => {
  const { info, diagnostics } = createDiagnostics(
    vi.fn(() => {
      throw new Error("synthetic diagnostic sink failure");
    }),
  );
  const originalError = new Error("synthetic append failure");
  const scope = diagnostics.scope("persist")!;
  expect(() => {
    try {
      clock = 1_500;
      throw originalError;
    } finally {
      diagnostics.finish();
    }
  }).toThrow(originalError);
  at(3_000, scope.finish);
  diagnostics.finish();
  expectLog(info, "slow chat send 1500ms stage=request persist=1500ms");
});

test("lexical detail scopes stop on failure without extending later request time", async () => {
  const { info, diagnostics } = createDiagnostics();
  const resume = createDeferredCore();
  const failure = new Error("synthetic owner failure");
  const pending = (async () => {
    using _ = diagnostics.scope("detail.persist.stage");
    await resume.promise;
    clock = 400;
    throw failure;
  })();
  const rejected = expect(pending).rejects.toBe(failure);
  resume.resolve();
  await rejected;
  at(1_200, diagnostics.finish);
  expectLog(info, "slow chat send 1200ms stage=request detail.persist.stage=400ms");
});

test("startup spans stay request-owned and include unfinished parents without timeline logging", async () => {
  const { info: firstLog, diagnostics: first } = createDiagnostics();
  const { info: secondLog, diagnostics: second } = createDiagnostics();
  const resume = createDeferredCore();
  first.acknowledge();
  second.acknowledge();
  const parent = observeTimeline(first.observeSpan, () =>
    measureSpan("reply.init_session_state", async () => {
      await resume.promise;
      measureSpanSync("agent.prepare", () => at(1_100), {
        attributes: { stage: "attempt.tool_catalog" },
      });
      first.finish();
    }),
  );
  clock = 1_000;
  observeTimeline(second.observeSpan, () =>
    measureSpanSync("reply.ensure_workspace", () => at(1_020)),
  );
  second.finish();
  resume.resolve();
  await parent;
  // A span finishing after startup cannot reopen or append to the completed report.
  first.finish();
  expectLog(
    firstLog,
    "slow chat send 1100ms stage=startup ack=0ms detail.attempt.tool_catalog=80ms detail.reply.init_session_state=1100ms",
  );
  expectLog(
    secondLog,
    "slow chat send 1020ms stage=startup ack=0ms detail.reply.ensure_workspace=20ms",
  );
});

test("span observer failures preserve synchronous and asynchronous results and errors", async () => {
  const failure = new Error("operation failure");
  const observer = () => {
    throw new Error("observer failure");
  };
  expect(observeTimeline(observer, () => measureSpanSync("sync", () => 42))).toBe(42);
  await expect(
    observeTimeline(
      () => () => {
        throw new Error("finish failure");
      },
      () =>
        measureSpan("async", async () => {
          throw failure;
        }),
    ),
  ).rejects.toBe(failure);
});
