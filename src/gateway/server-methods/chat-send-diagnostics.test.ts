import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  areDiagnosticsEnabledForProcess,
  onTrustedInternalDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import { startChatSendDiagnostics } from "./chat-send-diagnostics.js";

let previousDiagnostics: boolean;
let clock: number;
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
    const log = { info: vi.fn() };
    const diagnostics = startChatSendDiagnostics(log);
    diagnostics.scope("authority");
    clock = elapsedMs;
    diagnostics[Symbol.dispose]();
    if (elapsedMs < 1_000) {
      expect(log.info).not.toHaveBeenCalled();
    } else {
      expect(log.info).toHaveBeenCalledExactlyOnceWith(
        "slow chat send 1000ms stage=request authority=1000ms",
      );
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
    const log = { info: vi.fn() };
    try {
      const diagnostics = startChatSendDiagnostics(log);
      const request = diagnostics.scope("persist")!;
      clock = 10;
      request.mark("response");
      const snapshot = diagnostics.scope("snapshot")!;
      clock = 15;
      request.finish();
      diagnostics.acknowledge(stage === "queued" ? "startup" : stage);
      diagnostics[Symbol.dispose]();
      const parallel = diagnostics.scope("snapshot")!;
      clock = 815;
      parallel.finish();
      clock = 1_215;
      snapshot.mark("dispatch");
      clock = 1_415;
      diagnostics.finish({
        isSteered: () => false,
        isEnqueued: () => stage === "queued",
        isTerminal: () => false,
      });
      expect(events).toEqual([]);
      expect(log.info).toHaveBeenCalledExactlyOnceWith(
        `slow chat send 1400ms stage=${stage} ack=15ms snapshot=2000ms dispatch=200ms`,
      );

      clock = 4_000;
      snapshot.mark("effects");
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
      expect(log.info).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  },
);

test("logging failures preserve the send error and retire unfinished scopes", () => {
  const log = {
    info: vi.fn(() => {
      throw new Error("synthetic diagnostic sink failure");
    }),
  };
  const originalError = new Error("synthetic append failure");
  const diagnostics = startChatSendDiagnostics(log);
  const scope = diagnostics.scope("persist")!;
  expect(() => {
    try {
      clock = 1_500;
      throw originalError;
    } finally {
      diagnostics.finish();
    }
  }).toThrow(originalError);
  clock = 3_000;
  scope.finish();
  diagnostics.finish();
  expect(log.info).toHaveBeenCalledExactlyOnceWith(
    "slow chat send 1500ms stage=request persist=1500ms",
  );
});
