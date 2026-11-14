import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  buildCompactionDividerItem,
  clearWorkingProgress,
  resetWorkingProgress,
  resolveWorkingProgress,
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

describe("compaction savings", () => {
  it.each([
    [900_000, 24_700, "saved 875.3k tokens (97.3%)"],
    [1_000, 0, "saved 1k tokens (100%)"],
    [10_000, 9_990, "saved 10 tokens (0.1%)"],
    [1_000, undefined, undefined],
    [1_000, -10, undefined],
    [0, 0, undefined],
    [1_000, 1_100, undefined],
    [Number.POSITIVE_INFINITY, 10, undefined],
  ])("reports the reduction from %s to %s tokens", (tokensBefore, tokensAfter, metric) => {
    expect(buildCompactionDividerItem({ tokensBefore, tokensAfter }, 1_000, 0).metric).toBe(metric);
  });
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
