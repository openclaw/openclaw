import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  consumeStreamingEchoHandled,
  launchMirrorDispatch,
  registerChannelMirrorDispatcher,
  resetMirrorDispatchForTest,
  resolveChannelMirrorDispatcher,
  unregisterChannelMirrorDispatcher,
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
  it("re-registration replaces the dispatcher (last-wins, for account reload)", () => {
    resetMirrorDispatchForTest();
    const a = vi.fn();
    const b = vi.fn();
    registerChannelMirrorDispatcher("test-owner", "telegram", "default", a);
    registerChannelMirrorDispatcher("test-owner", "telegram", "default", b); // account reloaded -> replaces a
    expect(resolveChannelMirrorDispatcher("telegram", "default")).toBe(b);
    expect(resolveChannelMirrorDispatcher("discord", "default")).toBeUndefined();
  });

  it("unregister removes a stopped account's dispatcher", () => {
    resetMirrorDispatchForTest();
    const a = vi.fn();
    registerChannelMirrorDispatcher("test-owner", "telegram", "default", a);
    expect(resolveChannelMirrorDispatcher("telegram", "default")).toBe(a);
    unregisterChannelMirrorDispatcher("test-owner", "telegram", "default");
    expect(resolveChannelMirrorDispatcher("telegram", "default")).toBeUndefined();
  });

  it("is owner-scoped: a different owner cannot replace or unregister another owner's dispatcher", () => {
    resetMirrorDispatchForTest();
    const a = vi.fn();
    const b = vi.fn();
    registerChannelMirrorDispatcher("owner-a", "telegram", "default", a);
    // A DIFFERENT owner must not be able to hijack the (channel, account) entry —
    // the ownership boundary: an installed plugin cannot replace another
    // plugin/account's mirror handler.
    registerChannelMirrorDispatcher("owner-b", "telegram", "default", b);
    expect(resolveChannelMirrorDispatcher("telegram", "default")).toBe(a);
    // A different owner's unregister is a no-op.
    unregisterChannelMirrorDispatcher("owner-b", "telegram", "default");
    expect(resolveChannelMirrorDispatcher("telegram", "default")).toBe(a);
    // The OWNING registrant can still replace (account reload) and remove its entry.
    registerChannelMirrorDispatcher("owner-a", "telegram", "default", b);
    expect(resolveChannelMirrorDispatcher("telegram", "default")).toBe(b);
    unregisterChannelMirrorDispatcher("owner-a", "telegram", "default");
    expect(resolveChannelMirrorDispatcher("telegram", "default")).toBeUndefined();
  });

  it("uses the sole dispatcher only for a wildcard target, not an explicit account mismatch", () => {
    resetMirrorDispatchForTest();
    const a = vi.fn();
    registerChannelMirrorDispatcher("test-owner", "telegram", "default", a);
    // A wildcard target (no pinned account) may use the only registered dispatcher.
    expect(resolveChannelMirrorDispatcher("telegram")).toBe(a);
    expect(resolveChannelMirrorDispatcher("telegram", "")).toBe(a);
    // An explicit, DIFFERENT account fails closed even though only one is registered
    // — never mirror through an account the target did not pin.
    expect(resolveChannelMirrorDispatcher("telegram", "acct2")).toBeUndefined();
  });

  it("keys dispatchers by account and fails closed on a multi-account mismatch", async () => {
    resetMirrorDispatchForTest();
    const accA = vi.fn();
    const accB = vi.fn();
    registerChannelMirrorDispatcher("test-owner", "telegram", "acc-a", accA);
    registerChannelMirrorDispatcher("test-owner", "telegram", "acc-b", accB);
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
    registerChannelMirrorDispatcher("test-owner", "telegram", "default", dispatcher);

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

    // The target is marked handled so the post-hoc final echo skips it. The mark is
    // NON-destructive: it stays valid for every sent hook the origin run fires (it is
    // only cleared when the next run re-arms), so repeated reads keep returning true.
    expect(consumeStreamingEchoHandled("sk-1", TG)).toBe(true);
    expect(consumeStreamingEchoHandled("sk-1", TG)).toBe(true);
    handle.dispose();
  });

  it("un-marks a target when its dispatcher fails (post-hoc delivers, no silent drop)", async () => {
    resetMirrorDispatchForTest();
    const dispatcher = vi.fn(() => Promise.reject(new Error("context dropped")));
    registerChannelMirrorDispatcher("test-owner", "telegram", "default", dispatcher);
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

  it("fails closed for a mirror-capable channel with no dispatcher for the target account", async () => {
    resetMirrorDispatchForTest();
    // Channel is mirror-capable but the target's account (acc-c) is not registered;
    // with >1 account there is no single-dispatcher fallback, so resolve fails.
    registerChannelMirrorDispatcher("test-owner", "telegram", "acc-a", vi.fn());
    registerChannelMirrorDispatcher("test-owner", "telegram", "acc-b", vi.fn());
    const target = { channel: "telegram", to: "telegram:-100", accountId: "acc-c", threadId: 1 };
    const handle = await launchMirrorDispatch({
      originRunId: "run-fc",
      cfg,
      sessionKey: "sk-fc",
      sessionEntry: entryWith([target]),
      originChannel: "webchat",
      originTo: "",
    });
    // No native dispatch, but the target IS marked handled so the post-hoc echo is
    // suppressed — it would bypass the channel's enablement/revocation checks.
    expect(handle.count).toBe(0);
    expect(consumeStreamingEchoHandled("sk-fc", target)).toBe(true);
  });

  it("excludes the origin target (no self-mirror)", async () => {
    resetMirrorDispatchForTest();
    const dispatcher = vi.fn();
    registerChannelMirrorDispatcher("test-owner", "telegram", "default", dispatcher);
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
