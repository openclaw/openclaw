// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { showToast } from "../lib/toast.ts";
import { canReloadControlUiDocument } from "./document-reload-guard.ts";
import {
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
  stubGatewayStoreTestGlobals,
} from "./gateway-store.test-support.ts";

vi.mock("../lib/toast.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/toast.ts")>()),
  showToast: vi.fn(),
}));

describe("Gateway deferred intents", () => {
  let store: ReturnType<typeof createGatewayStoreTestStore>;
  let windowEvents: EventTarget;
  const setScope = (scope = "account-a", ready = true) =>
    Object.assign(store.current(), { recoveryScope: scope, recoveryScopeReady: ready });
  const hello = () => store.current().testOptions.onHello?.(GATEWAY_STORE_TEST_HELLO);
  const disconnect = () =>
    store.current().testOptions.onClose?.({ code: 1006, reason: "network lost", willRetry: true });
  const settle = async () => {
    for (let step = 0; step < 5; step += 1) {
      await Promise.resolve();
    }
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    stubGatewayStoreTestGlobals();
    windowEvents = new EventTarget();
    vi.stubGlobal("window", windowEvents);
    store = createGatewayStoreTestStore();
    store.gateway.start();
    setScope();
    hello();
  });

  afterEach(() => {
    store.gateway.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("preserves a lifecycle slot while replacing its value and discarding related intents", async () => {
    const calls: string[] = [];
    const discarded = vi.fn();
    disconnect();
    store.gateway.defer({
      key: "lifecycle",
      group: "session",
      run: async () => {
        calls.push("archive");
      },
    });
    store.gateway.defer({
      key: "other",
      run: async () => {
        calls.push("other");
      },
    });
    store.gateway.defer({
      key: "metadata",
      group: "session",
      run: async () => {
        calls.push("metadata");
      },
      discard: discarded,
    });
    store.gateway.defer({
      key: "lifecycle",
      group: "session",
      preservePosition: true,
      discardGroup: true,
      run: async () => {
        calls.push("delete");
      },
    });
    expect(store.gateway.snapshot.deferredIntentCount).toBe(2);
    expect(discarded).toHaveBeenCalledOnce();
    hello();
    await settle();
    expect(calls).toEqual(["delete", "other"]);
  });

  it("moves coalesced desired state to the tail and publishes reload custody until dispatch", async () => {
    const calls: string[] = [];
    const oldDiscard = vi.fn();
    const counts: number[] = [];
    store.gateway.subscribe((snapshot) => counts.push(snapshot.deferredIntentCount ?? 0));
    disconnect();
    expect(
      store.gateway.defer({
        key: "label",
        run: async () => {
          calls.push("old");
        },
        discard: oldDiscard,
      }),
    ).toBe(true);
    store.gateway.defer({
      key: "icon",
      run: async () => {
        calls.push("icon");
      },
    });
    store.gateway.defer({
      key: "label",
      run: async (client) => {
        expect(client).toBe(store.current());
        calls.push("new");
      },
    });
    expect(store.gateway.snapshot.deferredIntentCount).toBe(2);
    expect(canReloadControlUiDocument()).toBe(false);
    const unloading = new Event("beforeunload", { cancelable: true });
    windowEvents.dispatchEvent(unloading);
    expect(unloading.defaultPrevented).toBe(true);
    expect(calls).toEqual([]);

    hello();
    await settle();
    expect(calls).toEqual(["icon", "new"]);
    expect(oldDiscard).toHaveBeenCalledOnce();
    expect(counts).toContain(2);
    expect(counts.at(-1)).toBe(0);
    expect(canReloadControlUiDocument()).toBe(true);
    const released = new Event("beforeunload", { cancelable: true });
    windowEvents.dispatchEvent(released);
    expect(released.defaultPrevented).toBe(false);
  });

  it("waits for recovery scope resolution and rejects a changed account", async () => {
    disconnect();
    const run = vi.fn(async () => {});
    const discard = vi.fn();
    store.gateway.defer({ key: "label", run, discard });
    setScope("account-a", false);
    hello();
    expect(run).not.toHaveBeenCalled();
    setScope("account-b");
    store.current().testOptions.onRecoveryScopeChange?.();
    await settle();
    expect(run).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledOnce();
    expect(store.gateway.snapshot.deferredIntentCount).toBe(0);
    expect(showToast).toHaveBeenCalledWith({ message: "Offline changes discarded: 1" });
  });

  it.each(["account-a", "account-b"])(
    "retains queued work through Retry and admits only the captured scope (%s)",
    async (scope) => {
      disconnect();
      const run = vi.fn(async () => {});
      const discard = vi.fn();
      store.gateway.defer({ key: "label", run, discard });
      const previous = store.current();
      const revision = store.gateway.connectionRevision;

      store.gateway.connect();
      const replacement = store.current();
      expect(replacement).not.toBe(previous);
      expect(store.gateway.connectionRevision).toBe(revision);
      expect(store.gateway.snapshot.deferredIntentCount).toBe(1);
      expect(discard).not.toHaveBeenCalled();
      expect(showToast).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();

      setScope(scope);
      hello();
      await settle();
      if (scope === "account-a") {
        expect(run).toHaveBeenCalledExactlyOnceWith(replacement);
        expect(discard).not.toHaveBeenCalled();
        expect(showToast).not.toHaveBeenCalled();
      } else {
        expect(run).not.toHaveBeenCalled();
        expect(discard).toHaveBeenCalledOnce();
        expect(showToast).toHaveBeenCalledExactlyOnceWith({
          message: "Offline changes discarded: 1",
        });
      }
      expect(store.gateway.snapshot.deferredIntentCount).toBe(0);
    },
  );

  it.each(["stop", "credential change", "auth rejection", "retired recovery"] as const)(
    "discards once on %s and never dispatches the retired queue",
    async (retirement) => {
      disconnect();
      const run = vi.fn(async () => {});
      const discard = vi.fn();
      store.gateway.defer({ key: "label", run, discard });
      if (retirement === "stop") {
        store.gateway.stop();
      } else if (retirement === "credential change") {
        store.gateway.connect({ token: "other" });
        setScope();
      } else {
        if (retirement === "retired recovery") {
          Object.defineProperty(store.current(), "offlineRecoveryRetired", { value: true });
        }
        store.current().testOptions.onClose?.({
          code: 1008,
          reason: "rejected",
          willRetry: false,
          ...(retirement === "auth rejection"
            ? {
                error: {
                  code: "INVALID_REQUEST",
                  message: "rejected",
                  details: { code: ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH },
                },
              }
            : {}),
        });
      }
      hello();
      await settle();
      expect(run).not.toHaveBeenCalled();
      expect(discard).toHaveBeenCalledOnce();
      expect(showToast).toHaveBeenCalledExactlyOnceWith({
        message: "Offline changes discarded: 1",
      });
      expect(store.gateway.snapshot.deferredIntentCount).toBe(0);
      expect(canReloadControlUiDocument()).toBe(true);
    },
  );

  it("does not enqueue idle connected, stopped, or unadmitted work", () => {
    const run = vi.fn(async () => {});
    expect(store.gateway.defer({ key: "connected", run })).toBe(false);
    store.gateway.stop();
    expect(store.gateway.defer({ key: "stopped", run })).toBe(false);
    store.gateway.start();
    expect(store.gateway.defer({ key: "unadmitted", run })).toBe(false);
    expect(store.gateway.snapshot.deferredIntentCount).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["connect", "rejection"] as const)(
    "does not revive a store stopped by the %s discard observer",
    (transition) => {
      disconnect();
      store.gateway.defer({ key: "label", run: async () => {} });
      let stopped = false;
      const release = store.gateway.subscribe((snapshot) => {
        if (!stopped && snapshot.deferredIntentCount === 0) {
          stopped = true;
          store.gateway.stop();
        }
      });
      if (transition === "connect") {
        store.gateway.connect({ token: "other" });
      } else {
        store.current().testOptions.onClose?.({
          code: 1008,
          reason: "rejected",
          willRetry: false,
          error: { code: "PAIRING_REQUIRED", message: "rejected" },
        });
      }
      release();
      expect(store.gateway.snapshot.phase).toBe("stopped");
      expect(store.gateway.snapshot.client).toBeNull();
      expect(store.clients).toHaveLength(1);
    },
  );

  it("does not replay an in-flight intent after another disconnect and continues after failure", async () => {
    disconnect();
    let rejectFirst!: (error: Error) => void;
    const first = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    const second = vi.fn(async () => {});
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    store.gateway.defer({ key: "first", run: first });
    store.gateway.defer({ key: "second", run: second });
    hello();
    expect(store.gateway.snapshot.deferredIntentCount).toBe(1);
    disconnect();
    rejectFirst(new Error("synthetic interrupted request"));
    await settle();
    expect(second).not.toHaveBeenCalled();
    hello();
    await settle();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(store.gateway.snapshot.deferredIntentCount).toBe(0);
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });
});
