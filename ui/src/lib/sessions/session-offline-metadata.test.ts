// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  createGatewayStoreTestStore,
  stubGatewayStoreTestGlobals,
} from "../../app/gateway-store.test-support.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { showToast } from "../toast.ts";
import { createTestSessionCapability, sessionsResult } from "./session-capability.test-support.ts";

vi.mock("../toast.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../toast.ts")>()),
  showToast: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  stubGatewayStoreTestGlobals();
});
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const store = createGatewayStoreTestStore();
  store.gateway.start();
  const client = store.current();
  client.testOptions.offlineRecoveryScope = "metadata-owner";
  Object.defineProperties(client, {
    recoveryScope: { value: "metadata-owner" },
    recoveryScopeReady: { value: true },
  });
  const hello = {
    ...gatewayHelloForMethods(["sessions.patch", "sessions.list", "sessions.subscribe"]),
    auth: { role: "operator", scopes: ["operator.admin"], recoveryScope: "metadata-owner" },
  };
  let row = {
    key: "agent:main:offline",
    sessionId: "offline-incarnation",
    kind: "direct" as const,
    updatedAt: 1,
    label: "Original",
    icon: "star",
    color: "blue",
    category: "Work",
  };
  let reject = false;
  let rejectList = false;
  let nextPatchWait: Promise<void> | undefined;
  const confirmed = vi.fn();
  client.request.mockImplementation(async (method, params) => {
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.list") {
      if (rejectList) {
        throw new Error("Session list unavailable");
      }
      return sessionsResult([{ ...row }]);
    }
    if (method === "sessions.patch") {
      const wait = nextPatchWait;
      nextPatchWait = undefined;
      await wait;
      if (reject) {
        throw new Error("label already in use: Taken");
      }
      row = { ...row, ...(params as Partial<typeof row>), updatedAt: 2 };
      return { ok: true, key: row.key, path: "", entry: { ...row } };
    }
    return {};
  });
  client.testOptions.onHello?.(hello);
  const sessions = createTestSessionCapability(store.gateway);
  const errors: Array<string | null> = [];
  sessions.subscribe((state) => errors.push(state.error));
  const patches = () =>
    store.current().request.mock.calls.filter(([method]) => method === "sessions.patch");
  return {
    ...store,
    sessions,
    patches,
    confirmed,
    errors,
    holdNextPatch: (wait: Promise<void>) => {
      nextPatchWait = wait;
    },
    setServerRow: (patch: Partial<typeof row>) => {
      row = { ...row, ...patch };
    },
    offline: () =>
      client.testOptions.onClose?.({ code: 1006, reason: "network lost", willRetry: true }),
    reconnect: () => store.current().testOptions.onHello?.(hello),
    replaceClient: () => {
      store.gateway.connect();
      Object.assign(store.current(), {
        recoveryScope: "metadata-owner",
        recoveryScopeReady: true,
      });
      store.current().request.mockImplementation(client.request.getMockImplementation()!);
    },
    reject: () => {
      reject = true;
    },
    rejectList: () => {
      rejectList = true;
    },
    patch: (fields: Parameters<typeof sessions.patch>[1]) =>
      sessions.patch(row.key, fields, {
        agentId: "main",
        expectedSessionId: row.sessionId,
        onConfirmed: confirmed,
        deferListRefresh: true,
      }),
    row: () => sessions.presentation.result?.sessions[0],
  };
}

it.each([false, true])("retains offline metadata on replacement=%s", async (replace) => {
  const h = setup();
  try {
    await h.sessions.refresh({ agentId: "main" });
    h.offline();
    const first = h.patch({ label: "First" });
    expect(h.row()?.label).toBe("First");
    expect(h.gateway.snapshot.deferredIntentCount).toBe(1);
    await expect(first).resolves.toEqual({ queued: true });
    await expect(h.patch({ label: "Final" })).resolves.toEqual({ queued: true });
    await h.patch({ icon: "heart", color: "red", category: "Home" });
    expect(h.row()).toMatchObject({
      label: "Final",
      icon: "heart",
      color: "red",
      category: "Home",
    });
    expect(h.gateway.snapshot.deferredIntentCount).toBe(2);
    expect(h.patches()).toHaveLength(0);
    // A consequential field cannot hitch a ride with an otherwise safe label.
    await expect(h.patch({ label: "Unsafe", pinned: true })).resolves.toBeNull();
    if (replace) {
      h.replaceClient();
      expect(h.row()?.label).toBe("Final");
      expect(h.gateway.snapshot.deferredIntentCount).toBe(2);
    }
    h.reconnect();
    await vi.waitFor(() => expect(h.gateway.snapshot.deferredIntentCount).toBe(0));
    expect(h.patches()).toHaveLength(2);
    await vi.waitFor(() => expect(h.confirmed).toHaveBeenCalledTimes(2));
    expect(h.patches()[0]?.[1]).toMatchObject({
      key: "agent:main:offline",
      agentId: "main",
      expectedSessionId: "offline-incarnation",
      label: "Final",
    });
    await vi.waitFor(() =>
      expect(h.row()).toMatchObject({
        label: "Final",
        icon: "heart",
        color: "red",
        category: "Home",
      }),
    );
  } finally {
    h.sessions.dispose();
    h.gateway.stop();
  }
});

it.each([false, true])("orders new edits while the last request is in flight=%s", async (last) => {
  const h = setup();
  const first = createDeferred();
  try {
    await h.sessions.refresh({ agentId: "main" });
    h.offline();
    if (!last) {
      await h.patch({ icon: "heart" });
    }
    await h.patch({ label: "Old" });
    h.holdNextPatch(first.promise);
    h.reconnect();
    expect(h.gateway.snapshot.deferredIntentDraining).toBe(true);
    expect(h.gateway.snapshot.deferredIntentCount).toBe(last ? 0 : 1);
    await expect(h.patch({ label: "New" })).resolves.toEqual({ queued: true });
    expect(h.row()?.label).toBe("New");
    expect(h.patches()).toHaveLength(1);
    first.resolve();
    await vi.waitFor(() => expect(h.confirmed).toHaveBeenCalledTimes(2));
    expect(h.patches().map(([, params]) => params)).toMatchObject([
      last ? { label: "Old" } : { icon: "heart" },
      { label: "New" },
    ]);
    expect(h.row()?.label).toBe("New");
    expect(h.gateway.snapshot.deferredIntentCount).toBe(0);
    await vi.waitFor(() => expect(h.gateway.snapshot.deferredIntentDraining).toBe(false));
  } finally {
    first.resolve();
    h.sessions.dispose();
    h.gateway.stop();
  }
});

it.each(["rejection", "discard"])("rolls back queued metadata on %s", async (outcome) => {
  const h = setup();
  try {
    await h.sessions.refresh({ agentId: "main" });
    h.offline();
    await h.patch({ label: "Taken" });
    expect(h.row()?.label).toBe("Taken");
    if (outcome === "rejection") {
      h.reject();
      h.reconnect();
      await vi.waitFor(() =>
        expect(h.errors.some((error) => error?.includes("label already in use"))).toBe(true),
      );
      await vi.waitFor(() => expect(h.row()?.label).toBe("Original"));
      expect(showToast).toHaveBeenCalledExactlyOnceWith({ message: "label already in use: Taken" });
    } else {
      h.gateway.stop();
    }
    await vi.waitFor(() => expect(h.gateway.snapshot.deferredIntentCount).toBe(0));
    expect(h.row()?.label).not.toBe("Taken");
    expect(h.patches()).toHaveLength(outcome === "rejection" ? 1 : 0);
  } finally {
    h.sessions.dispose();
    h.gateway.stop();
  }
});

it("keeps the last icon choice when it overlaps an earlier appearance reset", async () => {
  const h = setup();
  try {
    await h.sessions.refresh({ agentId: "main" });
    h.offline();
    await h.patch({ icon: "heart" });
    await h.patch({ icon: null, color: null });
    await h.patch({ icon: "star" });
    expect(h.row()?.icon).toBe("star");
    expect(h.gateway.snapshot.deferredIntentCount).toBe(2);
    h.reconnect();
    await vi.waitFor(() => expect(h.confirmed).toHaveBeenCalledTimes(2));
    expect(h.patches()).toHaveLength(2);
    expect(h.patches().map(([, params]) => params)).toMatchObject([
      { icon: null, color: null },
      { icon: "star" },
    ]);
    await vi.waitFor(() => expect(h.row()?.icon).toBe("star"));
    expect(h.gateway.snapshot.deferredIntentCount).toBe(0);
    // A leaked optimistic claim would mask this later authoritative value.
    h.setServerRow({ icon: "moon", color: "red", updatedAt: 50 });
    await h.sessions.refresh({ agentId: "main", force: true });
    expect(h.row()).toMatchObject({ icon: "moon", color: "red" });
  } finally {
    h.sessions.dispose();
    h.gateway.stop();
  }
});

it.each(["confirmed", "rejected"])(
  "settles %s metadata held only by a filtered list",
  async (outcome) => {
    const h = setup();
    const scope = { agentId: "main", search: "Original" };
    const unsubscribe = h.sessions.subscribeList(scope, () => {});
    try {
      await h.sessions.refreshList(scope);
      expect(h.sessions.listSnapshot(scope).result?.sessions[0]?.label).toBe("Original");
      h.offline();
      await h.patch({ label: "Filtered rename" });
      expect(h.sessions.listSnapshot(scope).result?.sessions[0]?.label).toBe("Filtered rename");
      if (outcome === "rejected") {
        h.reject();
        h.rejectList();
      }
      h.reconnect();
      if (outcome === "confirmed") {
        await vi.waitFor(() => expect(h.confirmed).toHaveBeenCalledOnce());
      }
      await vi.waitFor(() =>
        expect(h.sessions.listSnapshot(scope).result?.sessions[0]?.label).toBe(
          outcome === "confirmed" ? "Filtered rename" : "Original",
        ),
      );
    } finally {
      unsubscribe();
      h.sessions.dispose();
      h.gateway.stop();
    }
  },
);
