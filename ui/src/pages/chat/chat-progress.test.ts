import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  clearWorkingProgress,
  resetWorkingProgress,
  resolveTurnRecap,
  resolveWorkingProgress,
  type TurnRecapWatch,
} from "./chat-progress.ts";

const SESSION = "agent:main:main";
const progress = (...args: Tail<Parameters<typeof resolveWorkingProgress>>) =>
  resolveWorkingProgress(SESSION, ...args);
type Tail<T extends unknown[]> = T extends [unknown, ...infer Rest] ? Rest : never;
const send = (
  sendRunId: string,
  createdAt: number,
  sendState: ChatQueueItem["sendState"],
  sendError?: string,
) => ({
  id: sendRunId,
  text: "Retained send",
  createdAt,
  sendRunId,
  sendState,
  sendAttempts: 1,
  ...(sendError ? { sendError } : {}),
});

describe("resolveWorkingProgress", () => {
  beforeEach(() => resetWorkingProgress());
  afterEach(() => {
    resetWorkingProgress();
    vi.useRealTimers();
  });

  it.each(["failed", "held", "waiting-idle"] as const)(
    "does not let an older %s send identify an unknown active turn",
    (sendState) => {
      expect(
        progress(
          null,
          2_000,
          [{ ...send("old-run", 1_000, sendState), sendError: "Review required" }],
          [],
          [],
        ),
      ).toMatchObject({ runId: null, startedAt: 2_000 });
    },
  );

  it.each(["failed", "held", "waiting-idle", "waiting-reconnect"] as const)(
    "retains matching durable timing from a %s send after the run is identified",
    (sendState) => {
      const queue = ["old-run", "active-run"].map((id, i) =>
        send(
          id,
          (i + 1) * 1_000,
          sendState,
          sendState === "waiting-reconnect" ? undefined : "Review required",
        ),
      );
      expect(progress("active-run", 3_000, queue, [], [])).toMatchObject({
        runId: "active-run",
        startedAt: 2_000,
      });
    },
  );

  it("keeps a submitted turn's identity and timing across a delayed foreign preamble", () => {
    const queue = [send("new-run", 60_000, "sending")];
    const submitted = progress(null, null, queue, [], []);
    const segments = [{ runId: "old-run", ts: 1_000 }];
    expect(progress(null, null, queue, segments, [])).toEqual(submitted);
    expect(progress("new-run", 61_000, [], segments, [])).toEqual(submitted);
    expect(submitted).toMatchObject({ runId: "new-run", startedAt: 60_000 });
  });

  it.each(["other-run", undefined])(
    "ignores stream and tool timing without matching ownership (%s)",
    (runId) => {
      expect(
        progress(
          "active-run",
          3_000,
          [],
          [
            { runId, ts: 500 },
            { runId: "active-run", ts: 2_000 },
          ],
          [
            { runId, __openclawToolStreamReceivedAt: 100 },
            { runId: "active-run", __openclawToolStreamReceivedAt: 2_500 },
          ],
        ),
      ).toMatchObject({ runId: "active-run", startedAt: 2_000 });
    },
  );

  it("prefers observed stream identity over a future queued send", () => {
    expect(
      progress(
        null,
        1_000,
        [send("future-run", 500, "waiting-reconnect")],
        [{ ts: 1_000, runId: "active-run" }],
        [],
      ),
    ).toMatchObject({ runId: "active-run", startedAt: 1_000 });
  });

  it("infers a new run only from activity received after the pane was idle", () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    clearWorkingProgress(SESSION);
    vi.setSystemTime(61_000);
    expect(
      progress(
        null,
        null,
        [],
        [{ ts: 800 }, { runId: "first-run", ts: 900 }],
        [
          { runId: "first-run", __openclawToolStreamReceivedAt: 1_100 },
          { runId: "second-run", __openclawToolStreamReceivedAt: 60_300 },
        ],
      ),
    ).toMatchObject({ runId: "second-run", startedAt: 60_300 });
  });

  it("bounds working timing while keeping a recently read run across session churn", () => {
    const retired = "agent:main:retired";
    resolveWorkingProgress(retired, "retired-run", 1_000, [], [], []);
    const current = progress("current-run", 2_000, [], [], []);
    for (let index = 0; index < 40; index++) {
      resolveWorkingProgress(`agent:main:other-${index}`, `run-${index}`, 3_000, [], [], []);
      if (index % 5 === 0) {
        expect(progress("current-run", 9_000, [], [], [])).toEqual(current);
      }
    }
    expect(progress("current-run", 9_000, [], [], [])).toEqual(current);
    expect(resolveWorkingProgress(retired, "retired-run", 9_000, [], [], [])).toMatchObject({
      runId: "retired-run",
      startedAt: 9_000,
    });
  });

  it("bounds idle cutoffs while preserving a recently read session's stale-activity barrier", () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const retired = "agent:main:retired";
    clearWorkingProgress(retired);
    clearWorkingProgress(SESSION);
    vi.setSystemTime(60_000);
    const stale = [{ runId: "stale-run", ts: 1_000 }];
    for (let index = 0; index < 40; index++) {
      clearWorkingProgress(`agent:main:other-${index}`);
      if (index % 5 === 0) {
        expect(progress(null, null, [], stale, [])).toMatchObject({
          runId: null,
          startedAt: 60_000,
        });
      }
    }
    expect(progress(null, null, [], stale, [])).toMatchObject({ runId: null, startedAt: 60_000 });
    expect(resolveWorkingProgress(retired, null, null, [], stale, [])).toMatchObject({
      runId: "stale-run",
      startedAt: 1_000,
    });
  });
});

describe("resolveTurnRecap", () => {
  let host: { turnRecapWatch: TurnRecapWatch | null };
  const runId = "watched-run";
  const doneRow = { lastRunId: runId, status: "done" as const, runtimeMs: 14_000 };
  const usage = (outputTokens: number | null, owner = runId) =>
    new Map([[owner, { outputTokens, seq: 1 }]]);
  const resolve = (params: Omit<Parameters<typeof resolveTurnRecap>[1], "sessionKey"> = {}) =>
    resolveTurnRecap(host, { sessionKey: SESSION, ...params });
  const finish = (outputTokens: number | null = 695) =>
    resolve({ row: doneRow, usageByRun: usage(outputTokens) });
  const watch = () => resolve({ indicator: { runId } });
  const recap = (outputTokens: number | null, runtimeMs = 14_000) => ({
    runId,
    runtimeMs,
    outputTokens,
  });

  beforeEach(() => {
    host = { turnRecapWatch: null };
  });

  it("matches the watched run instead of inferring identity from session-row values", () => {
    expect(watch()).toBeNull();
    expect(
      resolve({ row: { ...doneRow, lastRunId: "previous-run" }, usageByRun: usage(690) }),
    ).toBeNull();
    expect(finish(690)).toEqual(recap(690));
  });

  it("reconciles usage arriving after the first completed recap", () => {
    watch();
    for (const count of [690, 695, 680, null]) {
      expect(finish(count)).toEqual(recap(count));
    }
  });

  it("retains a matching terminal that arrives before the indicator disappears", () => {
    expect(resolve({ indicator: { runId }, row: doneRow, usageByRun: usage(695) })).toBeNull();
    expect(resolve()).toEqual(recap(695));
  });

  it("keeps a resolved recap against unwatched terminal rows and usage", () => {
    watch();
    const settledRecap = finish();
    expect(
      resolve({
        row: { ...doneRow, lastRunId: "foreign-run", runtimeMs: 1_000 },
        usageByRun: usage(900, "foreign-run"),
      }),
    ).toEqual(settledRecap);
  });

  it("waits for runtime data without borrowing another run's count", () => {
    watch();
    expect(
      resolve({ row: { lastRunId: runId, status: "done" }, usageByRun: usage(900, "foreign-run") }),
    ).toBeNull();
    expect(resolve({ row: doneRow, usageByRun: usage(900, "foreign-run") })).toEqual(recap(null));
  });

  it("reports equal counts on consecutive runs and preserves a known zero", () => {
    watch();
    expect(finish(0)?.outputTokens).toBe(0);
    const nextRunId = "next-run";
    expect(resolve({ indicator: { runId: nextRunId }, row: doneRow })).toBeNull();
    expect(resolve({ row: doneRow })).toBeNull();
    expect(
      resolve({ row: { ...doneRow, lastRunId: nextRunId }, usageByRun: usage(0, nextRunId) }),
    ).toEqual({ runId: nextRunId, runtimeMs: 14_000, outputTokens: 0 });
  });

  it("never reports a partial handoff token total, or less time than its last run", () => {
    resolve({ indicator: { runId, request: { askedAt: 1_000, runIds: ["handoff-run"] } } });
    expect(resolve({ row: { ...doneRow, endedAt: 9_000 }, usageByRun: usage(256) })).toEqual(
      recap(null),
    );
  });

  it("stays quiet for a watched failed run", () => {
    watch();
    expect(resolve({ row: { ...doneRow, status: "failed" }, usageByRun: usage(695) })).toBeNull();
    expect(
      resolve({
        row: { ...doneRow, lastRunId: "foreign-run" },
        usageByRun: usage(900, "foreign-run"),
      }),
    ).toBeNull();
  });

  it("retains a resumed request when the first identified event hides the working indicator", () => {
    resolve({ indicator: { request: { askedAt: 1_000, runIds: ["handoff-run"] } } });
    expect(resolve({ activeRunId: runId })).toBeNull();
    const usageByRun = new Map([
      ["handoff-run", { outputTokens: 4_100, seq: 1 }],
      [runId, { outputTokens: 256, seq: 2 }],
    ]);
    expect(resolve({ row: { ...doneRow, endedAt: 78_000 }, usageByRun })).toEqual(
      recap(4_356, 77_000),
    );
  });

  it("never invents a watch from history or an unidentified queued indicator", () => {
    expect(finish()).toBeNull();
    expect(resolve({ indicator: {}, row: doneRow })).toBeNull();
    expect(finish()).toBeNull();
  });

  it("clears the previous recap when a new queued turn has no run identity yet", () => {
    watch();
    expect(finish()).not.toBeNull();
    expect(resolve({ indicator: {}, startingNewTurn: true, row: doneRow })).toBeNull();
    expect(finish()).toBeNull();
  });

  it.each(["agent", "gateway"])(
    "invalidates a settled global recap when its %s changes",
    (owner) => {
      const params = {
        sessionKey: "global",
        agentId: "first",
        gatewayClient: createTestGatewayClient(() => null),
        usageByRun: usage(695),
      };
      resolveTurnRecap(host, { ...params, indicator: { runId } });
      expect(resolveTurnRecap(host, { ...params, row: doneRow })).not.toBeNull();
      const replacement =
        owner === "agent"
          ? { ...params, agentId: "second" }
          : { ...params, gatewayClient: createTestGatewayClient(() => null) };
      expect(resolveTurnRecap(host, { ...replacement, row: doneRow })).toBeNull();
      expect(resolveTurnRecap(host, { ...params, row: doneRow })).toBeNull();
    },
  );

  it("isolates watches by pane and resets them on session changes", () => {
    const other = { turnRecapWatch: null };
    watch();
    const params = { sessionKey: SESSION, row: doneRow, usageByRun: usage(695) };
    expect(resolveTurnRecap(other, params)).toBeNull();
    expect(resolveTurnRecap(host, params)).not.toBeNull();
    expect(resolveTurnRecap(host, { ...params, sessionKey: "other-session" })).toBeNull();
    expect(resolveTurnRecap(host, params)).toBeNull();
  });
});
