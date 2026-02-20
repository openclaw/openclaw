import { afterEach, describe, expect, it, vi } from "vitest";
import type { HookRunner } from "../plugins/hooks.js";
import { runSilentMessageIngest } from "./silent-ingest.js";

describe("runSilentMessageIngest", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sanitizes from and invokes message_ingest", async () => {
    const runMessageIngest = vi.fn(async () => {});
    const runner = {
      hasHooks: vi.fn(() => true),
      runMessageIngest,
    } as unknown as HookRunner;

    await runSilentMessageIngest({
      enabled: true,
      event: {
        from: "evil\nname",
        content: "  hello  ",
      },
      ctx: {
        channelId: "telegram",
        conversationId: "123",
      },
      hookRunner: runner,
      log: vi.fn(),
      logPrefix: "telegram",
    });

    expect(runMessageIngest).toHaveBeenCalledTimes(1);
    const calls = runMessageIngest.mock.calls as unknown[][];
    const event = calls[0]?.[0] as { from: string; content: string } | undefined;
    expect(event?.from).toBe("evilname");
    expect(event?.content).toBe("hello");
  });

  it("skips work when no message_ingest hooks are registered", async () => {
    const runMessageIngest = vi.fn(async () => {});
    const runner = {
      hasHooks: vi.fn(() => false),
      runMessageIngest,
    } as unknown as HookRunner;

    const res = await runSilentMessageIngest({
      enabled: true,
      event: { from: "x", content: "hello" },
      ctx: { channelId: "signal", conversationId: "g1" },
      hookRunner: runner,
      log: vi.fn(),
      logPrefix: "signal",
    });

    expect(res).toBe(false);
    expect(runMessageIngest).not.toHaveBeenCalled();
  });

  it("clears timeout timer on fast completion", async () => {
    vi.useFakeTimers();
    const runMessageIngest = vi.fn(async () => {});
    const runner = {
      hasHooks: vi.fn(() => true),
      runMessageIngest,
    } as unknown as HookRunner;

    await runSilentMessageIngest({
      enabled: true,
      event: { from: "x", content: "hello" },
      ctx: { channelId: "signal", conversationId: "g1" },
      hookRunner: runner,
      log: vi.fn(),
      logPrefix: "signal",
    });

    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps inflight slot until timed-out hook actually settles", async () => {
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const runMessageIngest = vi.fn(async () => blocked);
    const runner = {
      hasHooks: vi.fn(() => true),
      runMessageIngest,
    } as unknown as HookRunner;
    const log = vi.fn();

    const first = runSilentMessageIngest({
      enabled: true,
      event: { from: "x", content: "hello" },
      ctx: { channelId: "signal", conversationId: "g1" },
      hookRunner: runner,
      timeoutMs: 1,
      maxInflight: 1,
      log,
      logPrefix: "signal",
    });

    await new Promise((r) => setTimeout(r, 10));

    const second = await runSilentMessageIngest({
      enabled: true,
      event: { from: "y", content: "hello" },
      ctx: { channelId: "signal", conversationId: "g1" },
      hookRunner: runner,
      timeoutMs: 1,
      maxInflight: 1,
      log,
      logPrefix: "signal",
    });

    expect(await first).toBe(false);
    expect(second).toBe(false);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("ingest skipped (too many inflight hooks in conversation"),
    );

    release();
    await new Promise((r) => setTimeout(r, 0));
  });
});
