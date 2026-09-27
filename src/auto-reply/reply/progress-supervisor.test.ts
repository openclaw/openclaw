import { afterEach, describe, expect, it, vi } from "vitest";
import { ProgressSupervisorSchema } from "../../config/zod-schema.agent-entry-base.js";
import { isHostProgressSupervisorPayload, type ReplyPayload } from "../reply-payload.js";
import {
  createProgressSupervisor,
  resolveProgressSupervisorConfig,
} from "./progress-supervisor.js";

const DEFAULT_PROGRESS_SUPERVISOR_INTERVAL_MS = 55_000;
const DEFAULT_PROGRESS_SUPERVISOR_TEXT =
  "Work is still in progress. Another update will follow if needed.";
const MAX_PROGRESS_SUPERVISOR_INTERVAL_SECONDS = 2_147_483;

afterEach(() => vi.useRealTimers());

describe("progress supervisor", () => {
  it("emits once per quiet period and rearms only after visible progress", async () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const supervisor = createProgressSupervisor({ enabled: true, emit });
    supervisor.start();

    await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESS_SUPERVISOR_INTERVAL_MS - 1);
    expect(emit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(isHostProgressSupervisorPayload(emit.mock.calls[0]![0])).toBe(true);

    await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESS_SUPERVISOR_INTERVAL_MS);
    expect(emit).toHaveBeenCalledOnce();
    supervisor.noteVisibleReply();
    await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESS_SUPERVISOR_INTERVAL_MS);
    expect(emit).toHaveBeenCalledTimes(2);
    await supervisor.stop();
  });

  it("restarts the quiet interval after a visible reply", async () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const supervisor = createProgressSupervisor({ enabled: true, intervalMs: 1_000, emit });
    supervisor.start();
    await vi.advanceTimersByTimeAsync(900);
    supervisor.noteVisibleReply();
    await vi.advanceTimersByTimeAsync(999);
    expect(emit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(emit).toHaveBeenCalledOnce();
    await supervisor.stop();
  });

  it("does not overlap emissions and joins one already in flight on stop", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const emit = vi.fn(() => pending);
    const supervisor = createProgressSupervisor({ enabled: true, intervalMs: 1_000, emit });
    supervisor.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(emit).toHaveBeenCalledOnce();

    let stopped = false;
    const stopping = supervisor.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    await vi.runAllTimersAsync();
    expect(emit).toHaveBeenCalledOnce();
  });

  it("stops before a terminal quiet interval can emit", async () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const supervisor = createProgressSupervisor({ enabled: true, intervalMs: 1_000, emit });
    supervisor.start();
    await vi.advanceTimersByTimeAsync(900);
    await supervisor.stop();
    await vi.runAllTimersAsync();
    expect(emit).not.toHaveBeenCalled();
  });

  it("invalidates the timer immediately on abort", async () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const abort = new AbortController();
    const supervisor = createProgressSupervisor({
      enabled: true,
      intervalMs: 1_000,
      abortSignal: abort.signal,
      emit,
    });
    supervisor.start();
    await vi.advanceTimersByTimeAsync(900);
    abort.abort();
    await vi.runAllTimersAsync();
    expect(emit).not.toHaveBeenCalled();
    await supervisor.stop();
  });

  it("is opt-in and inherits per-agent fields over global defaults", async () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    createProgressSupervisor({ enabled: false, intervalMs: 1, emit }).start();
    await vi.runAllTimersAsync();
    expect(emit).not.toHaveBeenCalled();

    expect(
      resolveProgressSupervisorConfig({
        agentId: "main",
        cfg: {
          agents: {
            defaults: {
              progressSupervisor: { enabled: true, intervalSeconds: 55, text: "Working." },
            },
            entries: { main: { progressSupervisor: { intervalSeconds: 12 } } },
          },
        },
      }),
    ).toEqual({ enabled: true, intervalMs: 12_000, text: "Working." });
    expect(resolveProgressSupervisorConfig({ agentId: "other", cfg: {} })).toEqual({
      enabled: false,
      intervalMs: DEFAULT_PROGRESS_SUPERVISOR_INTERVAL_MS,
      text: DEFAULT_PROGRESS_SUPERVISOR_TEXT,
    });
  });

  it("bounds interval conversion to operational and setTimeout-safe values", () => {
    expect(ProgressSupervisorSchema.safeParse({ intervalSeconds: 4 }).success).toBe(false);
    expect(ProgressSupervisorSchema.safeParse({ intervalSeconds: 5 }).success).toBe(true);
    expect(
      ProgressSupervisorSchema.safeParse({
        intervalSeconds: MAX_PROGRESS_SUPERVISOR_INTERVAL_SECONDS,
      }).success,
    ).toBe(true);
    expect(
      ProgressSupervisorSchema.safeParse({
        intervalSeconds: MAX_PROGRESS_SUPERVISOR_INTERVAL_SECONDS + 1,
      }).success,
    ).toBe(false);
  });

  it("invalidates a queued notice when visible delivery advances its generation", async () => {
    vi.useFakeTimers();
    let queued: ReplyPayload | undefined;
    const supervisor = createProgressSupervisor({
      enabled: true,
      intervalMs: 1_000,
      emit: (payload) => {
        queued = payload;
      },
    });
    supervisor.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(queued && supervisor.isCurrentPayload(queued)).toBe(true);
    supervisor.noteVisibleReply();
    expect(queued && supervisor.isCurrentPayload(queued)).toBe(false);
    await supervisor.stop();
  });
});
