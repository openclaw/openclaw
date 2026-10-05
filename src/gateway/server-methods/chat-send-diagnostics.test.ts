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

test.each(["success", "error"] as const)(
  "keeps admitted startup identity and reports %s only after actual settlement",
  async (outcome) => {
    const log = { info: vi.fn() };
    const diagnostics = startChatSendDiagnostics(log);
    const identity = {
      runId: "recovery:session:cycle",
      sessionId: "session",
      lifecycleGeneration: "generation",
    };
    diagnostics.bindRun(identity);
    diagnostics.bindRun({ ...identity, runId: "unrelated-successor" });
    diagnostics.acknowledge();
    const deferred = Promise.withResolvers<string>();
    const error = new Error("synthetic private error must not be logged");
    const measured = diagnostics.measure("worktree", () => deferred.promise);
    expect(log.info).toHaveBeenCalledExactlyOnceWith("run phase", {
      owner: "chat",
      ...identity,
      name: "chat.send.worktree",
      spanId: 1,
      status: "entry",
      startedAt: expect.any(Number),
    });
    // ACK/disposal and backend start cannot manufacture settlement of a pending await.
    diagnostics[Symbol.dispose]();
    diagnostics.finish();
    expect(log.info).toHaveBeenCalledOnce();
    if (outcome === "success") {
      deferred.resolve("prepared");
      await expect(measured).resolves.toBe("prepared");
    } else {
      deferred.reject(error);
      await expect(measured).rejects.toBe(error);
    }
    expect(log.info.mock.calls[1]).toEqual([
      "run phase",
      {
        owner: "chat",
        ...identity,
        name: "chat.send.worktree",
        spanId: 1,
        status: outcome,
        startedAt: log.info.mock.calls[0]?.[1]?.startedAt,
        endedAt: expect.any(Number),
        durationMs: expect.any(Number),
      },
    ]);
    expect(log.info).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.info.mock.calls)).not.toContain(error.message);
  },
);

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

test("acknowledgement splits overlapping phases into request and startup observations", async () => {
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
    diagnostics.acknowledge();
    diagnostics[Symbol.dispose]();
    const parallel = diagnostics.scope("snapshot")!;
    clock = 815;
    parallel.finish();
    clock = 1_215;
    snapshot.mark("dispatch");
    clock = 1_415;
    diagnostics.finish();
    expect(events).toEqual([]);
    expect(log.info).toHaveBeenCalledExactlyOnceWith(
      "slow chat send 1400ms stage=startup ack=15ms snapshot=2000ms dispatch=200ms",
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
      { name: "chat.send.snapshot", durationMs: 2_000, details: { stage: "startup" } },
      { name: "chat.send.dispatch", durationMs: 200, details: { stage: "startup" } },
    ]);
    expect(log.info).toHaveBeenCalledOnce();
  } finally {
    stop();
  }
});

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
