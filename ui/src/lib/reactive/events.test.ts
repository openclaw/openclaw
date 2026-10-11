import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { clearBootRecords } from "../../app/boot-record.ts";
import { fetchControlUiResource, notifyBrowserAuthRestored } from "../../app/browser-http.ts";
import { patchChatSessionSettings } from "../../pages/chat/chat-settings-patches.ts";
import { prepareInitialTurnHandoff } from "../../pages/chat/initial-turn-handoff.ts";
import { publishSnapshotInvalidation } from "../../pages/chat/session-snapshot-invalidation-events.ts";
import { clearFirstRunActivationReceipt } from "../../pages/model-setup/first-run-activation-receipt.ts";
import { notifyDurableComposerDraftChanges } from "../chat/composer-draft-changes.ts";
import { notifyChatOutboxAttentionChanges } from "../chat/outbox-owner-registry.ts";
import { notifyStoredChatOutboxChanges } from "../chat/outbox-store.ts";
import type { SessionPatchOptions, SessionPatchResult } from "../sessions/patch.ts";
import {
  projectBootRecordChanges,
  projectBrowserAuthRestored,
  projectBrowserHttpFailures,
  projectChatOutboxAttentionChanges,
  projectChatPickerPatchConfirmations,
  projectDurableComposerDraftChanges,
  projectFirstRunActivationCleared,
  projectInitialTurnHandoff,
  projectSnapshotInvalidation,
  projectStoredChatOutboxChanges,
} from "./events.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("event projections", () => {
  it.each([
    {
      name: "browser auth restoration",
      project: projectBrowserAuthRestored,
      publish: notifyBrowserAuthRestored,
    },
    {
      name: "stored outbox changes",
      project: projectStoredChatOutboxChanges,
      publish: notifyStoredChatOutboxChanges,
    },
    {
      name: "durable draft changes",
      project: projectDurableComposerDraftChanges,
      publish: notifyDurableComposerDraftChanges,
    },
  ])(
    "delivers every $name notification and releases the final listener",
    ({ project, publish }) => {
      const projection = project();
      cleanups.push(projection.dispose);
      publish();
      const first = vi.fn();
      const releaseFirst = projection.subscribe(first);
      const second = vi.fn();
      const releaseSecond = projection.subscribe(second);
      expect(first).not.toHaveBeenCalled();
      publish();
      publish();
      expect(first).toHaveBeenCalledTimes(2);
      releaseFirst();
      publish();
      expect(first).toHaveBeenCalledTimes(2);
      expect(second).toHaveBeenCalledTimes(3);
      releaseSecond();
      publish();
      expect(second).toHaveBeenCalledTimes(3);
      projection.subscribe(first);
      publish();
      expect(first).toHaveBeenCalledTimes(3);
      projection.dispose();
      publish();
      expect(first).toHaveBeenCalledTimes(3);
    },
  );

  it("preserves scoped boot-record retirement payloads and repeated retirements", () => {
    const projection = projectBootRecordChanges();
    cleanups.push(projection.dispose);
    const receive = vi.fn();
    projection.subscribe(receive);
    const owner = { recoveryScope: "synthetic-recovery" };
    clearBootRecords("scope-a", owner);
    clearBootRecords("scope-a", owner);
    expect(receive.mock.calls).toEqual([
      [{ scope: "scope-a", retiredOwner: owner }],
      [{ scope: "scope-a", retiredOwner: owner }],
    ]);
    projection.dispose();
    clearBootRecords("scope-a", owner);
    expect(receive).toHaveBeenCalledTimes(2);
  });

  it("forwards every HTTP authorization failure without changing the response", async () => {
    const response = new Response(null, { status: 401 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const projection = projectBrowserHttpFailures();
    cleanups.push(projection.dispose);
    const receive = vi.fn();
    projection.subscribe(receive);
    expect(await fetchControlUiResource("/resource")).toBe(response);
    await fetchControlUiResource("/resource");
    expect(receive.mock.calls).toEqual([["/resource"], ["/resource"]]);
    projection.dispose();
    await fetchControlUiResource("/resource");
    expect(receive).toHaveBeenCalledTimes(2);
  });

  it("retains outbox attention owner identities and duplicate invalidations", () => {
    const projection = projectChatOutboxAttentionChanges();
    cleanups.push(projection.dispose);
    const receive = vi.fn();
    projection.subscribe(receive);
    notifyChatOutboxAttentionChanges("first");
    notifyChatOutboxAttentionChanges("first");
    notifyChatOutboxAttentionChanges("second");
    expect(receive.mock.calls).toEqual([["first"], ["first"], ["second"]]);
    projection.dispose();
    notifyChatOutboxAttentionChanges("late");
    expect(receive).toHaveBeenCalledTimes(3);
  });

  it("keeps snapshot invalidation publication pending until its consumers settle", async () => {
    const projection = projectSnapshotInvalidation();
    cleanups.push(projection.dispose);
    const completion = createDeferred();
    const receive = vi.fn(() => completion.promise);
    const release = projection.subscribe(receive);
    const settled = vi.fn();
    const published = publishSnapshotInvalidation({
      sessionKey: "agent:main:one",
      reason: "cache-eviction",
    }).then(settled);
    await Promise.resolve();
    expect(receive).toHaveBeenCalledWith({
      sessionKey: "agent:main:one",
      reason: "cache-eviction",
    });
    expect(settled).not.toHaveBeenCalled();
    completion.resolve();
    await published;
    release();
    await publishSnapshotInvalidation({});
    expect(receive).toHaveBeenCalledOnce();
  });

  it("notifies for each initial-turn handoff without replaying a previous handoff", () => {
    vi.useFakeTimers();
    const projection = projectInitialTurnHandoff();
    cleanups.push(projection.dispose);
    const item = { id: "handoff", text: "Synthetic turn", createdAt: 1 };
    prepareInitialTurnHandoff("agent:main:one", item);
    const receive = vi.fn();
    projection.subscribe(receive);
    expect(receive).not.toHaveBeenCalled();
    prepareInitialTurnHandoff("agent:main:one", item);
    prepareInitialTurnHandoff("agent:main:one", item);
    expect(receive).toHaveBeenCalledTimes(2);
    projection.dispose();
    prepareInitialTurnHandoff("agent:main:one", item);
    expect(receive).toHaveBeenCalledTimes(2);
    vi.runOnlyPendingTimers();
  });

  it("forwards local and cross-document activation clearing receipts", () => {
    const key = "openclaw.modelSetup.pendingActivation.v1";
    const projection = projectFirstRunActivationCleared();
    cleanups.push(projection.dispose);
    const receive = vi.fn();
    projection.subscribe(receive);
    localStorage.setItem(key, "synthetic-receipt");
    clearFirstRunActivationReceipt();
    window.dispatchEvent(
      new StorageEvent("storage", { key, oldValue: "synthetic-receipt", newValue: null }),
    );
    expect(receive.mock.calls).toEqual([["synthetic-receipt"], ["synthetic-receipt"]]);
    projection.dispose();
    window.dispatchEvent(new StorageEvent("storage", { key, oldValue: "late", newValue: null }));
    expect(receive).toHaveBeenCalledTimes(2);
  });

  it("adapts real pending picker receipts without exposing another global channel", async () => {
    const first = createDeferred<SessionPatchResult | null>();
    const second = createDeferred<SessionPatchResult | null>();
    const options: SessionPatchOptions[] = [];
    let current = true;
    // Only the session patch tail and connection receipt are under test.
    const host = {
      sessions: {
        captureConnectionScope: () => ({}),
        isConnectionScopeCurrent: () => current,
        patch: (_key: string, _patch: unknown, option: SessionPatchOptions) => {
          options.push(option);
          return options.length === 1 ? first.promise : second.promise;
        },
      },
    } as unknown as Parameters<typeof patchChatSessionSettings>[0];
    const pendingFirst = patchChatSessionSettings(host, "agent:main:one", { model: "example/one" });
    const pendingSecond = patchChatSessionSettings(host, "agent:main:one", {
      model: "example/two",
    });
    const receipt = options[1]?.predecessorReceipt;
    expect(receipt).toBeDefined();
    if (!receipt) {
      throw new Error("Expected pending-tail receipt");
    }
    const projection = projectChatPickerPatchConfirmations(receipt);
    cleanups.push(projection.dispose);
    const receive = vi.fn();
    projection.subscribe(receive);
    expect(receive).not.toHaveBeenCalled();
    // The adapter passes the exact opaque acknowledgement through untouched.
    const result: SessionPatchResult = {
      ok: true,
      path: "/synthetic/sessions.json",
      key: "agent:main:one",
      entry: { sessionId: "session-one" },
    };
    options[0]?.onConfirmed?.(result);
    options[0]?.onConfirmed?.(result);
    expect(receive.mock.calls).toEqual([[result], [result]]);
    current = false;
    options[0]?.onConfirmed?.(result);
    expect(receive).toHaveBeenCalledTimes(2);
    projection.dispose();
    first.resolve(null);
    second.resolve(null);
    await Promise.all([pendingFirst, pendingSecond]);
  });
});
