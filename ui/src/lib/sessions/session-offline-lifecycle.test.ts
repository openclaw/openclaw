// @vitest-environment node
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { roleScopesAllow } from "../../../../src/shared/operator-scope-compat.js";
import { resolveBaseSessionMutationRequiredScope } from "../../../../src/shared/session-method-scopes-base.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  createGatewayStoreTestStore,
  stubGatewayStoreTestGlobals,
} from "../../app/gateway-store.test-support.ts";
import { projectSidebarArchiveVisibility } from "../../components/app-sidebar-session-archive-visibility.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { readSessionMethodAccess } from "../session-method-access.ts";
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

async function setup(archived = false, scopes = ["operator.admin"], metadata = false) {
  const store = createGatewayStoreTestStore();
  store.gateway.start();
  const client = store.current();
  const recoveryScope = metadata ? "metadata-owner" : "lifecycle-owner";
  client.testOptions.offlineRecoveryScope = recoveryScope;
  Object.assign(client, { recoveryScope, recoveryScopeReady: true });
  const hello = {
    ...gatewayHelloForMethods([
      "sessions.patch",
      ...(!metadata ? ["sessions.delete", "sessions.describe"] : []),
      "sessions.list",
      "sessions.subscribe",
    ]),
    auth: { role: "operator", scopes, recoveryScope },
  };
  let row: GatewaySessionRow | null = {
    key: "agent:main:offline",
    sessionId: metadata ? "offline-incarnation" : "incarnation",
    kind: "direct",
    label: "Original",
    ...(metadata
      ? { icon: "star", color: "blue", category: "Work" }
      : { archived, pinned: !archived, sharingRole: "owner" as const }),
    updatedAt: 1,
  };
  let reject = false;
  let rejectList = false;
  let nextPatchWait: Promise<void> | undefined;
  const confirmed = vi.fn();
  let missingReject = false;
  client.request.mockImplementation(async (method, params) => {
    const requiredScope = resolveBaseSessionMutationRequiredScope(method, params);
    if (
      requiredScope &&
      !roleScopesAllow({
        role: hello.auth.role,
        requestedScopes: [requiredScope],
        allowedScopes: hello.auth.scopes,
      })
    ) {
      throw new Error(`Missing scope: ${requiredScope}`);
    }
    if (method === "sessions.list") {
      if (rejectList) {
        throw new Error("Session list unavailable");
      }
      return sessionsResult(row ? [{ ...row }] : []);
    }
    if (!metadata && method === "sessions.describe") {
      return { session: row };
    }
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.patch") {
      if (metadata) {
        const wait = nextPatchWait;
        nextPatchWait = undefined;
        await wait;
      }
      if (reject) {
        throw new Error(metadata ? "label already in use: Taken" : "Lifecycle denied");
      }
      if (!row) {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Session changed before patch. Retry.",
          details: { reason: "session-changed" },
        });
      }
      const patch = params as Partial<GatewaySessionRow>;
      row = {
        ...row,
        ...patch,
        ...(patch.archived === true ? { pinned: false } : {}),
        updatedAt: 2,
      };
      return { ok: true, key: row.key, path: "", entry: { ...row } };
    }
    if (!metadata && method === "sessions.delete") {
      if (reject) {
        throw new Error("Lifecycle denied");
      }
      if (!row && missingReject) {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Session changed before deletion. Retry.",
          details: { reason: "session-changed" },
        });
      }
      if ((params as { archivedOnly?: boolean }).archivedOnly && !row?.archived) {
        throw new Error("Not archived");
      }
      const deleted = row !== null;
      row = null;
      return { ok: true, key: "agent:main:offline", deleted, archived: [] };
    }
    return {};
  });
  client.testOptions.onHello?.(hello);
  const sessions = createTestSessionCapability(store.gateway);
  if (!metadata) {
    await sessions.refresh({ agentId: "main" });
  }
  onTestFinished(() => {
    sessions.dispose();
    store.gateway.stop();
  });
  const target = { agentId: "main", expectedSessionId: row!.sessionId };
  const errors: Array<string | null> = [];
  sessions.subscribe((state) => errors.push(state.error));
  return {
    ...store,
    sessions,
    target,
    confirmed,
    errors,
    patches: () =>
      store.current().request.mock.calls.filter(([method]) => method === "sessions.patch"),
    holdNextPatch: (wait: Promise<void>) => {
      nextPatchWait = wait;
    },
    rejectList: () => {
      rejectList = true;
    },
    setServerFields: (fields: Partial<GatewaySessionRow>) => {
      row = { ...row!, ...fields };
    },
    patchMetadata: (fields: Parameters<typeof sessions.patch>[1]) =>
      sessions.patch("agent:main:offline", fields, {
        ...target,
        onConfirmed: confirmed,
        deferListRefresh: true,
      }),
    offline: () => client.testOptions.onClose?.({ code: 1006, reason: "lost", willRetry: true }),
    reconnect: () => store.current().testOptions.onHello?.(hello),
    replace: () => {
      store.gateway.connect();
      Object.assign(store.current(), {
        recoveryScope,
        recoveryScopeReady: true,
      });
      store.current().request.mockImplementation(client.request.getMockImplementation()!);
    },
    reject: () => {
      reject = true;
    },
    gone: (rejectMissing = false) => {
      missingReject = rejectMissing;
      row = null;
    },
    setServerRow: (next: GatewaySessionRow) => {
      row = next;
    },
    row: () => sessions.presentation.result?.sessions[0],
    patch: (nextArchived: boolean) =>
      sessions.patch("agent:main:offline", { archived: nextArchived }, target),
    delete: () =>
      sessions.delete("agent:main:offline", {
        ...target,
        ...(sessions.presentation.result?.sessions[0]?.archived ? { archivedOnly: true } : {}),
      }),
    writes: () =>
      store
        .current()
        .request.mock.calls.filter(
          ([method]) => method === "sessions.patch" || method === "sessions.delete",
        ),
  };
}

it("rejects a missing offline delete identity before a reconnect can publish its successor", async () => {
  const h = await setup();
  h.offline();
  const deletion = h.sessions.delete("agent:main:future", { agentId: "main" });
  h.setServerRow({
    key: "agent:main:future",
    sessionId: "successor",
    kind: "direct",
    updatedAt: 2,
  });
  h.reconnect();
  await expect(deletion).rejects.toThrow("without its session identity");
  await h.sessions.refresh({ agentId: "main", force: true });
  expect(h.row()?.sessionId).toBe("successor");
  expect(h.writes()).toHaveLength(0);
});

it("coalesces the first offline delete and archive before the optional runtime loads", async () => {
  const h = await setup();
  h.offline();
  const deletion = h.delete();
  expect(h.row()).toBeUndefined();
  const archive = h.patch(true);
  expect(h.row()).toMatchObject({ sessionId: "incarnation", archived: true, pinned: false });
  expect(h.gateway.snapshot.deferredIntentCount).toBe(1);
  h.reconnect();
  await expect(deletion).resolves.toMatchObject({ queued: true });
  await expect(archive).resolves.toEqual({ queued: true });
  await vi.waitFor(() => expect(h.gateway.snapshot.deferredIntentDraining).toBe(false));
  expect(h.writes().map(([method]) => method)).toEqual(["sessions.patch"]);
  expect(h.row()).toMatchObject({ sessionId: "incarnation", archived: true });
});

it.each([false, true])(
  "projects and replays an offline archive across replacement=%s",
  async (replace) => {
    const h = await setup();
    h.offline();
    const archive = h.patch(true);
    expect(h.row()).toMatchObject({ archived: true, pinned: false });
    await expect(archive).resolves.toEqual({ queued: true });
    const visibility = (statusFilter: "active" | "archived") =>
      projectSidebarArchiveVisibility({
        sourceRows: h.sessions.presentation.result?.sessions ?? [],
        sessionData: {
          childSessionRowsByParent: {},
          loadedChildSessionKeys: new Set(),
          loadingChildSessionKeys: new Set(),
          childSessionErrorsByParent: new Map(),
        },
        selectedAgentId: "main",
        statusFilter,
        now: 1,
        deletionState: h.sessions.deletionState,
        archiveVisibility: h.sessions.archiveVisibility,
      });
    expect(visibility("active").rows).toHaveLength(0);
    expect(visibility("archived").rows.map((row) => row.key)).toEqual(["agent:main:offline"]);
    expect(h.gateway.snapshot.deferredIntentCount).toBe(1);
    expect(h.writes()).toHaveLength(0);
    if (replace) {
      h.replace();
    }
    expect(h.row()?.archived).toBe(true);
    h.reconnect();
    await vi.waitFor(() => expect(h.gateway.snapshot.deferredIntentDraining).toBe(false));
    expect(h.writes()).toHaveLength(1);
    expect(h.writes()[0]?.[0]).toBe("sessions.patch");
    expect(h.writes()[0]?.[1]).toMatchObject({ ...h.target, archived: true });
    expect(h.row()?.archived).toBe(true);
  },
);

it.each(["archive", "delete"])("rolls back a rejected offline %s", async (kind) => {
  const h = await setup();
  h.offline();
  await (kind === "archive" ? h.patch(true) : h.delete());
  if (kind === "delete") {
    await h.delete();
    expect(h.row()).toBeUndefined();
    expect(h.gateway.snapshot.deferredIntentCount).toBe(1);
  }
  h.reject();
  h.reconnect();
  await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith({ message: "Lifecycle denied" }));
  expect(h.row()).toMatchObject({ label: "Original", archived: false, pinned: true });
  expect(h.sessions.presentation.result?.sessions).toHaveLength(1);
});

it.each(["present", "replacement client", "gone", "missing incarnation"])(
  "hides and replays offline deletion when the target is %s",
  async (target) => {
    const h = await setup();
    h.offline();
    await h.delete();
    expect(h.row()).toBeUndefined();
    expect(h.gateway.snapshot.deferredIntentCount).toBe(1);
    if (target === "replacement client") {
      h.replace();
      expect(h.row()).toBeUndefined();
    }
    if (target === "gone") {
      h.gone();
    }
    if (target === "missing incarnation") {
      h.gone(true);
    }
    h.reconnect();
    await vi.waitFor(() =>
      expect(h.sessions.deletionState("agent:main:offline", "main", "incarnation")).toBe(
        "confirmed",
      ),
    );
    expect(h.writes()).toHaveLength(1);
    expect(h.row()).toBeUndefined();
    expect(showToast).not.toHaveBeenCalled();
  },
);

it.each(["unarchive", "delete"])(
  "coalesces archive then %s into one lifecycle intent",
  async (last) => {
    const h = await setup();
    h.offline();
    await h.patch(true);
    await (last === "delete" ? h.delete() : h.patch(false));
    expect(h.gateway.snapshot.deferredIntentCount).toBe(1);
    expect(h.row()?.archived).toBe(last === "delete" ? undefined : false);
    h.reconnect();
    await vi.waitFor(() => expect(h.gateway.snapshot.deferredIntentDraining).toBe(false));
    expect(h.writes().map(([method]) => method)).toEqual(
      last === "delete" ? ["sessions.patch", "sessions.delete"] : ["sessions.patch"],
    );
    expect(h.writes()[0]?.[1]).toMatchObject({ ...h.target, archived: last === "delete" });
    if (last === "delete") {
      expect(h.writes()[1]?.[1]).toMatchObject({ ...h.target, archivedOnly: true });
    }
  },
);

it.each(["deleted", "delete rejected", "connection replaced", "already gone"] as const)(
  "preserves the write-scope archive prerequisite when the offline delete is %s",
  async (outcome) => {
    const h = await setup(false, ["operator.write"]);
    h.offline();
    await h.patch(true);
    expect(
      readSessionMethodAccess(h.gateway.snapshot, {
        method: "sessions.delete",
        params: { key: "agent:main:offline", ...h.target, archivedOnly: true },
        allowDeferred: true,
        session: h.row(),
      }).allowed,
    ).toBe(true);
    await h.delete();
    expect(h.gateway.snapshot.deferredIntentCount).toBe(1);
    expect(h.row()).toBeUndefined();
    if (outcome === "already gone") {
      h.gone(true);
    }
    const request = h.current().request.getMockImplementation()!;
    h.current().request.mockImplementation(async (method, params) => {
      const result = await request(method, params);
      if (method === "sessions.patch") {
        if (outcome === "delete rejected") {
          h.reject();
        } else if (outcome === "connection replaced") {
          h.replace();
        }
      }
      return result;
    });
    const originalClient = h.current();
    h.reconnect();
    await vi.waitFor(() =>
      expect(h.gateway.snapshot).toMatchObject({
        deferredIntentCount: 0,
        deferredIntentDraining: false,
      }),
    );
    const writes = originalClient.request.mock.calls.filter(
      ([method]) => method === "sessions.patch" || method === "sessions.delete",
    );
    expect(writes.map(([method]) => method)).toEqual(
      outcome === "already gone" || outcome === "connection replaced"
        ? ["sessions.patch"]
        : ["sessions.patch", "sessions.delete"],
    );
    expect(writes[0]?.[1]).toMatchObject({ ...h.target, archived: true });
    if (outcome === "connection replaced") {
      h.reconnect();
      await h.sessions.refresh({ agentId: "main", force: true });
      expect(h.writes()).toEqual([]);
      expect(h.row()?.archived).toBe(true);
    } else if (outcome === "delete rejected") {
      expect(h.row()).toMatchObject({ archived: true, pinned: false });
      expect(h.sessions.state.error).toContain("Lifecycle denied");
    } else {
      expect(h.row()).toBeUndefined();
      expect(h.sessions.deletionState("agent:main:offline")).toBe("confirmed");
      expect(h.sessions.state.error).toBeNull();
    }
    if (writes[1]) {
      expect(writes[1][1]).toMatchObject({ ...h.target, archivedOnly: true });
    }
  },
);

it("discards metadata before hiding a delete, and restores it when archive replaces delete", async () => {
  const h = await setup();
  h.offline();
  const rename = h.sessions.patch("agent:main:offline", { label: "Unsent name" }, h.target);
  expect(h.row()?.label).toBe("Unsent name");
  const deletion = h.delete();
  expect(h.gateway.snapshot.deferredIntentCount).toBe(1);
  expect(h.row()).toBeUndefined();
  const archive = h.patch(true);
  expect(h.row()).toMatchObject({ label: "Original", archived: true });
  expect(h.gateway.snapshot.deferredIntentCount).toBe(1);
  await Promise.all([rename, deletion, archive]);
  h.reconnect();
  await vi.waitFor(() => expect(h.gateway.snapshot.deferredIntentDraining).toBe(false));
  expect(h.writes()).toHaveLength(1);
  expect(h.writes()[0]?.[0]).toBe("sessions.patch");
});

it.each(["archive", "delete"])(
  "rolls back discarded offline %s without another error toast",
  async (kind) => {
    const h = await setup();
    h.offline();
    await (kind === "archive" ? h.patch(true) : h.delete());
    h.gateway.connect({ token: "new-synthetic-owner" });
    expect(h.gateway.snapshot.deferredIntentCount).toBe(0);
    expect(h.sessions.deletionState("agent:main:offline", "main", "incarnation")).toBeUndefined();
    expect(showToast).toHaveBeenCalledExactlyOnceWith({ message: "Offline changes discarded: 1" });
    expect(h.writes()).toHaveLength(0);
  },
);

it("reports targets without an identity while queuing the rest of an offline delete batch", async () => {
  const h = await setup();
  h.offline();
  const missing = { key: "agent:main:missing", agentId: "main" };
  const operation = h.sessions.deleteMany([
    missing,
    { key: "agent:main:offline", ...h.target },
    { key: "agent:main:second", agentId: "main", expectedSessionId: "second-id" },
  ]);
  expect(h.row()).toBeUndefined();
  expect(h.gateway.snapshot.deferredIntentCount).toBe(2);
  const result = await operation;
  const message =
    'Cannot queue deletion of "agent:main:missing" without its session identity. Refresh after reconnecting and try again.';
  expect(result.errors).toEqual([{ target: missing, error: new Error(message) }]);
  expect(showToast).toHaveBeenCalledWith({ message });
  expect(h.sessions.state.error).toBe(message);
  expect(result.queued).toEqual(["agent:main:offline", "agent:main:second"]);
  expect(h.gateway.snapshot.deferredIntentCount).toBe(2);
  expect(h.sessions.deletionState(missing.key, missing.agentId)).toBeUndefined();
  expect(h.writes()).toHaveLength(0);
});

it("moves an offline unarchive to active and restores the archive on rejection", async () => {
  const h = await setup(true);
  h.offline();
  await h.patch(false);
  expect(h.row()?.archived).toBe(false);
  expect(h.sessions.archiveVisibility("agent:main:offline")).toBeUndefined();
  h.reject();
  h.reconnect();
  await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith({ message: "Lifecycle denied" }));
  expect(h.row()?.archived).toBe(true);
});

it("releases a dispatched archive when transport replacement rejects the old request", async () => {
  const h = await setup();
  const reply = createDeferred();
  const dispatched = createDeferred();
  const request = h.current().request.getMockImplementation()!;
  h.current().request.mockImplementation((method, params) => {
    if (method === "sessions.patch" && (params as { archived?: boolean }).archived) {
      dispatched.resolve();
      return reply.promise;
    }
    return request(method, params);
  });
  h.offline();
  await h.patch(true);
  await h.sessions.patch(
    "agent:main:other",
    { label: "Other" },
    {
      agentId: "main",
      expectedSessionId: "other-id",
    },
  );
  h.reconnect();
  await dispatched.promise;
  expect(h.row()?.archived).toBe(true);
  expect(h.gateway.snapshot.deferredIntentCount).toBe(1);
  // GatewayProtocolClient.stop flushes every pending request before replacement.
  vi.spyOn(h.current(), "stop").mockImplementationOnce(() =>
    reply.reject(new Error("gateway client stopped")),
  );
  h.replace();
  await vi.waitFor(() => expect(h.row()?.archived).toBe(false));
  expect(h.sessions.archiveVisibility("agent:main:offline")).toBeUndefined();
  expect(h.gateway.snapshot.deferredIntentCount).toBe(1);
  expect(showToast).not.toHaveBeenCalled();
});

it("retires an old client's in-flight delete even when unrelated metadata is queued", async () => {
  const h = await setup();
  const reply = createDeferred<{ deleted: boolean }>();
  onTestFinished(() => reply.resolve({ deleted: false }));
  const request = h.current().request.getMockImplementation()!;
  h.current().request.mockImplementation((method, params) =>
    method === "sessions.delete" ? reply.promise : request(method, params),
  );
  const deletion = h.delete();
  expect(h.row()).toBeUndefined();
  h.offline();
  await h.sessions.patch(
    "agent:main:other",
    { label: "Other" },
    {
      agentId: "main",
      expectedSessionId: "other-id",
    },
  );
  expect(h.gateway.snapshot.deferredIntentCount).toBe(1);
  h.replace();
  expect(h.sessions.deletionState("agent:main:offline", "main", "incarnation")).toBeUndefined();
  expect(h.row()).toMatchObject({ label: "Original", archived: false });
  reply.resolve({ deleted: true });
  await deletion;
  expect(h.sessions.deletionState("agent:main:offline", "main", "incarnation")).toBeUndefined();
});

it("reports a preserved worktree after deferred deletion without removing it", async () => {
  const h = await setup();
  const request = h.current().request.getMockImplementation()!;
  h.current().request.mockImplementation(async (method, params) => {
    const result = await request(method, params);
    return method === "sessions.delete"
      ? {
          ok: true,
          key: "agent:main:offline",
          deleted: true,
          archived: [],
          worktreePreserved: {
            id: "synthetic-worktree",
            branch: "feature/offline",
            path: "/synthetic/worktree",
            reason: "busy",
          },
        }
      : result;
  });
  h.offline();
  await h.delete();
  h.reconnect();
  await vi.waitFor(() => expect(h.gateway.snapshot.deferredIntentDraining).toBe(false));
  expect(showToast).toHaveBeenCalledExactlyOnceWith({
    message: "Managed Worktrees:\nfeature/offline — live run or cleanup active",
  });
  expect(h.row()).toBeUndefined();
  expect(h.current().request.mock.calls.some(([method]) => method === "worktrees.remove")).toBe(
    false,
  );
});

it.each([false, true])(
  "does not publish a retired delete's absence-check error (missing incarnation=%s)",
  async (missingIncarnation) => {
    const h = await setup();
    const described = createDeferred<{ session: null }>();
    const describing = createDeferred();
    const replayed = createDeferred();
    onTestFinished(() => described.resolve({ session: null }));
    const request = h.current().request.getMockImplementation()!;
    h.current().request.mockImplementation((method, params) => {
      if (method === "sessions.describe") {
        describing.resolve();
        return described.promise;
      }
      return request(method, params);
    });
    const defer = h.gateway.defer;
    vi.spyOn(h.gateway, "defer").mockImplementation((intent) =>
      defer({
        ...intent,
        run: async (client) => {
          try {
            await intent.run(client);
          } finally {
            replayed.resolve();
          }
        },
      }),
    );
    h.offline();
    await h.delete();
    h.gone(missingIncarnation);
    h.reconnect();
    await describing.promise;
    h.gateway.connect({ token: "replacement-synthetic-account" });
    described.resolve({ session: null });
    await replayed.promise;
    expect(h.sessions.state.error).toBeNull();
    expect(showToast).not.toHaveBeenCalled();
  },
);

it.each([false, true])("retains offline metadata on replacement=%s", async (replace) => {
  const h = await setup(false, undefined, true);
  await h.sessions.refresh({ agentId: "main" });
  h.offline();
  const first = h.patchMetadata({ label: "First" });
  expect(h.row()?.label).toBe("First");
  expect(h.gateway.snapshot.deferredIntentCount).toBe(1);
  await expect(first).resolves.toEqual({ queued: true });
  await expect(h.patchMetadata({ label: "Final" })).resolves.toEqual({ queued: true });
  await h.patchMetadata({ icon: "heart", color: "red", category: "Home" });
  expect(h.row()).toMatchObject({
    label: "Final",
    icon: "heart",
    color: "red",
    category: "Home",
  });
  expect(h.gateway.snapshot.deferredIntentCount).toBe(2);
  expect(h.patches()).toHaveLength(0);
  // A consequential field cannot hitch a ride with an otherwise safe label.
  await expect(h.patchMetadata({ label: "Unsafe", pinned: true })).resolves.toBeNull();
  if (replace) {
    h.replace();
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
});

it.each([false, true])("orders new edits while the last request is in flight=%s", async (last) => {
  const h = await setup(false, undefined, true);
  const first = createDeferred();
  try {
    await h.sessions.refresh({ agentId: "main" });
    h.offline();
    if (!last) {
      await h.patchMetadata({ icon: "heart" });
    }
    await h.patchMetadata({ label: "Old" });
    h.holdNextPatch(first.promise);
    h.reconnect();
    expect(h.gateway.snapshot.deferredIntentDraining).toBe(true);
    expect(h.gateway.snapshot.deferredIntentCount).toBe(last ? 0 : 1);
    await expect(h.patchMetadata({ label: "New" })).resolves.toEqual({ queued: true });
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
  }
});

it.each(["rejection", "discard"])("rolls back queued metadata on %s", async (outcome) => {
  const h = await setup(false, undefined, true);
  await h.sessions.refresh({ agentId: "main" });
  h.offline();
  await h.patchMetadata({ label: "Taken" });
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
});

it("keeps the last icon choice when it overlaps an earlier appearance reset", async () => {
  const h = await setup(false, undefined, true);
  await h.sessions.refresh({ agentId: "main" });
  h.offline();
  await h.patchMetadata({ icon: "heart" });
  await h.patchMetadata({ icon: null, color: null });
  await h.patchMetadata({ icon: "star" });
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
  h.setServerFields({ icon: "moon", color: "red", updatedAt: 50 });
  await h.sessions.refresh({ agentId: "main", force: true });
  expect(h.row()).toMatchObject({ icon: "moon", color: "red" });
});

it.each(["confirmed", "rejected"])(
  "settles %s metadata held only by a filtered list",
  async (outcome) => {
    const h = await setup(false, undefined, true);
    const scope = { agentId: "main", search: "Original" };
    const unsubscribe = h.sessions.subscribeList(scope, () => {});
    try {
      await h.sessions.refreshList(scope);
      expect(h.sessions.listSnapshot(scope).result?.sessions[0]?.label).toBe("Original");
      h.offline();
      await h.patchMetadata({ label: "Filtered rename" });
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
    }
  },
);
