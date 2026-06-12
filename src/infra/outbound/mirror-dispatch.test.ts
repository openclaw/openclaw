import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  consumeStreamingEchoHandled,
  launchMirrorDispatch,
  registerChannelMirrorDispatcher,
  resetMirrorDispatchForTest,
  resolveChannelMirrorDispatcher,
} from "./mirror-dispatch.js";

function entryWith(
  targets: Array<{
    channel: string;
    to: string;
    accountId?: string;
    threadId?: string | number;
  }>,
): SessionEntry {
  return { echoTargets: targets.map((t) => ({ ...t, addedAt: 1 })) } as unknown as SessionEntry;
}

const cfg = {} as OpenClawConfig;
const TG = { channel: "telegram", to: "telegram:-100", accountId: "default", threadId: 1 };

describe("mirror-dispatch", () => {
  it("registers and resolves a channel mirror dispatcher (first-wins per account)", () => {
    resetMirrorDispatchForTest();
    const a = vi.fn();
    const b = vi.fn();
    registerChannelMirrorDispatcher("telegram", "default", a);
    registerChannelMirrorDispatcher("telegram", "default", b); // ignored (first-wins)
    expect(resolveChannelMirrorDispatcher("telegram", "default")).toBe(a);
    expect(resolveChannelMirrorDispatcher("discord", "default")).toBeUndefined();
  });

  it("keys dispatchers by account and fails closed on a multi-account mismatch", async () => {
    resetMirrorDispatchForTest();
    const accA = vi.fn();
    const accB = vi.fn();
    registerChannelMirrorDispatcher("telegram", "acc-a", accA);
    registerChannelMirrorDispatcher("telegram", "acc-b", accB);
    // Exact account match resolves THAT account's runtime.
    expect(resolveChannelMirrorDispatcher("telegram", "acc-b")).toBe(accB);
    expect(resolveChannelMirrorDispatcher("telegram", "acc-a")).toBe(accA);
    // Unknown account with >1 registered → fail closed (post-hoc delivers).
    expect(resolveChannelMirrorDispatcher("telegram", "acc-c")).toBeUndefined();

    // A target mirrors through its OWN account's dispatcher only.
    const handle = await launchMirrorDispatch({
      originRunId: "run-acct",
      cfg,
      sessionKey: "sk-acct",
      sessionEntry: entryWith([
        { channel: "telegram", to: "telegram:-100", accountId: "acc-b", threadId: 1 },
      ]),
      originChannel: "webchat",
      originTo: "",
    });
    expect(handle.count).toBe(1);
    expect(accB).toHaveBeenCalledTimes(1);
    expect(accA).not.toHaveBeenCalled();
    handle.dispose();
  });

  it("dispatches a mirror turn to each resolved target with a bus-sourced resolver, marks handled", async () => {
    resetMirrorDispatchForTest();
    const dispatcher = vi.fn();
    registerChannelMirrorDispatcher("telegram", "default", dispatcher);

    const handle = await launchMirrorDispatch({
      originRunId: "run-1",
      cfg,
      sessionKey: "sk-1",
      sessionEntry: entryWith([TG]),
      originChannel: "webchat",
      originTo: "",
    });

    expect(handle.count).toBe(1);
    expect(dispatcher).toHaveBeenCalledTimes(1);
    const arg = dispatcher.mock.calls[0][0] as {
      target: { channel: string };
      replyResolver: unknown;
    };
    expect(arg.target.channel).toBe("telegram");
    expect(typeof arg.replyResolver).toBe("function");

    // The target is marked handled so the post-hoc final echo skips it — single-use.
    expect(consumeStreamingEchoHandled("sk-1", TG)).toBe(true);
    expect(consumeStreamingEchoHandled("sk-1", TG)).toBe(false);
    handle.dispose();
  });

  it("un-marks a target when its dispatcher fails (post-hoc delivers, no silent drop)", async () => {
    resetMirrorDispatchForTest();
    const dispatcher = vi.fn(() => Promise.reject(new Error("context dropped")));
    registerChannelMirrorDispatcher("telegram", "default", dispatcher);
    await launchMirrorDispatch({
      originRunId: "run-fail",
      cfg,
      sessionKey: "sk-fail",
      sessionEntry: entryWith([TG]),
      originChannel: "webchat",
      originTo: "",
    });
    // Let the rejected fire-and-forget promise settle.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    // Failure un-marked the target, so the post-hoc final echo still delivers.
    expect(consumeStreamingEchoHandled("sk-fail", TG)).toBe(false);
  });

  it("skips a target whose channel has no dispatcher (post-hoc handles it)", async () => {
    resetMirrorDispatchForTest();
    const handle = await launchMirrorDispatch({
      originRunId: "run-2",
      cfg,
      sessionKey: "sk-2",
      sessionEntry: entryWith([{ channel: "discord", to: "discord:42" }]),
      originChannel: "webchat",
      originTo: "",
    });
    expect(handle.count).toBe(0);
    expect(consumeStreamingEchoHandled("sk-2", { channel: "discord", to: "discord:42" })).toBe(
      false,
    );
  });

  it("excludes the origin target (no self-mirror)", async () => {
    resetMirrorDispatchForTest();
    const dispatcher = vi.fn();
    registerChannelMirrorDispatcher("telegram", "default", dispatcher);
    const handle = await launchMirrorDispatch({
      originRunId: "run-3",
      cfg,
      sessionKey: "sk-3",
      sessionEntry: entryWith([TG]),
      originChannel: "telegram",
      originTo: "telegram:-100",
      originAccountId: "default",
      originThreadId: 1,
    });
    expect(handle.count).toBe(0);
    expect(dispatcher).not.toHaveBeenCalled();
  });
});
