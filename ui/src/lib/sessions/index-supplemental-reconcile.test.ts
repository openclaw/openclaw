// @vitest-environment node
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { publishActiveSessionLineage } from "../../components/app-sidebar-child-session-data.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

const key = "agent:main:device-session";
const child = {
  key,
  sessionId: "session-device",
  kind: "direct" as const,
  updatedAt: 10,
};
const initialChild = { ...child, label: "Initial child" };
const query = { ownerId: "ada", agentId: "main" };
const refreshOptions = { agentId: "main", force: true };

function setup(request: Parameters<typeof createTestGatewayClient>[0], listQuery?: typeof query) {
  vi.useFakeTimers();
  const client = createTestGatewayClient(request);
  const { gateway, emitEvent } = createGatewayHarness(client);
  const sessions = createTestSessionCapability(gateway);
  const unsubscribe = listQuery && sessions.subscribeList(listQuery, () => {});
  onTestFinished(() => {
    unsubscribe?.();
    vi.useRealTimers();
  });
  return {
    client,
    sessions,
    emitChange: (payload: Record<string, unknown>) =>
      emitEvent({ type: "event", event: "sessions.changed", payload }),
    list: () => sessions.listSnapshot(listQuery ?? query).result,
    row: () => sessions.listSnapshot(listQuery ?? query).result?.sessions[0],
    primary: () => sessions.state.result?.sessions[0],
    refresh: async () => {
      await sessions.refresh(refreshOptions);
      if (listQuery) {
        await sessions.refreshList(listQuery);
      }
    },
  };
}

function sibling<T extends GatewaySessionRow>(row: T, label: string) {
  return { ...row, key: "agent:main:sibling", sessionId: "session-sibling", label };
}

function expectInvalidated(
  row: GatewaySessionRow | undefined,
  identity: Partial<GatewaySessionRow>,
  soft = false,
) {
  const assert = soft ? expect.soft : expect;
  assert(row).toMatchObject(identity);
  for (const field of ["thinkingLevels", "thinkingOptions", "thinkingDefault"] as const) {
    assert(row).not.toHaveProperty(field);
  }
}

function thinkingCatalog(...levels: string[]) {
  return {
    thinkingLevels: levels.map((id) => ({ id, label: id.charAt(0).toUpperCase() + id.slice(1) })),
    thinkingOptions: levels,
    thinkingDefault: levels.at(-1),
  };
}

function publishLineage(
  sessions: ReturnType<typeof createTestSessionCapability>,
  row: GatewaySessionRow,
) {
  const owner = {
    activeSessionLineageRoot: null,
    activeSessionLineageSelectedRow: null,
    childSessionRowsByParent: {},
    context: { sessions },
    sessionsResult: sessions.state.result,
  };
  publishActiveSessionLineage(
    owner,
    row.key,
    { rowsByParent: {}, topmostRow: row, lookupFailed: false },
    sessions.inheritRow,
    () => true,
  );
  return owner;
}

function placement(status: "available" | "offline") {
  return {
    state: "active" as const,
    generation: 4,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
    environmentId: "environment-device",
    activeOwnerEpoch: 7,
    workerBundleHash: "a".repeat(64),
    workspaceBaseManifestRef: "manifest-device",
    remoteWorkspaceDir: "/workspace",
    runner: { kind: "device" as const, status },
  };
}

function capabilityWithList(result: ReturnType<typeof sessionsResult>) {
  const request = vi.fn(async (method: string) => {
    if (method !== "sessions.list") {
      throw new Error(`Unexpected request: ${method}`);
    }
    return result;
  });
  const client = { request } as unknown as GatewayBrowserClient;
  return createTestSessionCapability(createGatewayHarness(client).gateway);
}

describe("supplemental session reconciliation", () => {
  it.each(["model", "runtime"] as const)(
    "keeps thinking catalog invalidation after a %s change crosses an older list",
    async (changedIdentity) => {
      const initial = {
        ...child,
        updatedAt: 20,
        archived: false,
        modelProvider: "test-provider",
        model: "model-a",
        agentRuntime: { id: "runtime-a", source: "model" as const },
        ...thinkingCatalog("low", "high"),
      };
      const selected = {
        modelProvider: initial.modelProvider,
        model: changedIdentity === "model" ? "model-b" : initial.model,
        agentRuntime: {
          id: changedIdentity === "runtime" ? "runtime-b" : initial.agentRuntime.id,
          source: "model" as const,
        },
      };
      const catalog = { ...initial, ...selected, ...thinkingCatalog("medium") };
      const delayed = createDeferred<ReturnType<typeof sessionsResult>>();
      let hold = false;
      let reply = initial;
      const { sessions, emitChange, primary } = setup(async (method) => {
        expect(method).toBe("sessions.list");
        return hold ? delayed.promise : sessionsResult([{ ...reply }], 20);
      });
      const options = { agentId: "main", includeLastMessage: true, force: true };
      let pending: Promise<void> | undefined;
      try {
        await sessions.refresh(options);
        hold = true;
        pending = sessions.refresh(options);
        emitChange({
          sessionKey: key,
          agentId: "main",
          sessionId: initial.sessionId,
          kind: "direct",
          reason: "patch",
          updatedAt: 20,
          archived: false,
          ...selected,
        });
        expectInvalidated(primary(), selected);

        delayed.resolve(sessionsResult([{ ...initial }], 20));
        await pending;
        expectInvalidated(primary(), selected, true);

        hold = false;
        reply = catalog;
        await sessions.refresh(options);
        expect(primary()).toEqual(
          expect.objectContaining({ ...selected, ...thinkingCatalog("medium") }),
        );
      } finally {
        delayed.resolve(sessionsResult([initial], 20));
        await pending;
      }
    },
  );

  it.each(["sibling", "duplicate"] as const)(
    "keeps an earlier captured child read current after appending a %s page",
    async (page) => {
      const initial = { ...child, label: "Page one child" };
      const later =
        page === "duplicate"
          ? { ...initial, updatedAt: 30, label: "Discarded duplicate" }
          : sibling(initial, "Page two sibling");
      const pageQuery = { ...query, limit: 1 };
      const { sessions, list, refresh } = setup(async (method, params) => {
        expect(method).toBe("sessions.list");
        const offset = (params as { offset?: number }).offset;
        return {
          ...sessionsResult([{ ...(offset ? later : initial) }], offset ? 30 : 10),
          totalCount: 2,
          hasMore: !offset,
          nextOffset: offset ? null : 1,
        };
      }, pageQuery);
      await refresh();
      const reconcile = sessions.captureReconcile();
      await sessions.refreshList({ ...pageQuery, append: true, offset: 1 });
      const listed = list();
      expect(listed?.sessions[0]?.label).toBe(initial.label);
      expect(listed?.sessions.map((row) => row.key)).toEqual(
        page === "duplicate" ? [key] : [key, later.key],
      );
      const fresh = { ...initial, updatedAt: 20, label: "Accepted child" };
      expect(reconcile(fresh)).toBe(true);
      expect(list()).toMatchObject({
        totalCount: 2,
        hasMore: false,
        nextOffset: null,
        sessions: page === "duplicate" ? [fresh] : [fresh, later],
      });
    },
  );

  it.each([
    ["older response", undefined, true],
    ["replacement", undefined, true],
    ["deletion", undefined, true],
    ["older response", "full", true],
    ["older response", "full", false],
    ["older response", null, true],
    ["older response", null, false],
  ] as const)(
    "preserves managed-row order across %s (permission: %s, primary: %s)",
    async (scenario, permission, primaryPresent) => {
      const initial = {
        ...initialChild,
        placement: placement("available"),
        permissionMode: "guarded" as const,
      };
      let current = initial;
      const other = sibling(initial, "Initial sibling");
      const delayed = createDeferred<ReturnType<typeof sessionsResult>>();
      let holdManaged = false;
      let omitPrimary = false;
      const {
        sessions,
        emitChange,
        list,
        row,
        primary,
        refresh: load,
      } = setup(async (method, params) => {
        expect(method).toBe("sessions.list");
        if (holdManaged && (params as { ownerId?: string }).ownerId) {
          return delayed.promise;
        }
        return sessionsResult(
          omitPrimary && !(params as { ownerId?: string }).ownerId
            ? [other]
            : [{ ...current }, ...(scenario === "older response" ? [other] : [])],
          current.updatedAt,
        );
      }, query);
      let refresh: Promise<void> | undefined;
      try {
        await load();
        if (scenario === "older response") {
          holdManaged = true;
          refresh = sessions.refreshList({ ...query, force: true });
        }
        const reconcile = sessions.captureReconcile();
        const accepted = {
          ...initial,
          updatedAt: 20,
          label: "Accepted child",
          placement: placement("offline"),
        };
        if (scenario === "older response") {
          expect(reconcile(accepted)).toBe(true);
          expect(row()).toMatchObject(accepted);
          if (permission !== undefined) {
            emitChange({
              key,
              sessionId: initial.sessionId,
              updatedAt: 30,
              permissionMode: permission,
            });
            expect(primary()?.permissionMode).toBe(permission ?? undefined);
            if (!primaryPresent) {
              omitPrimary = true;
              await sessions.refresh(refreshOptions);
              expect(sessions.state.result?.sessions.map((item) => item.key)).toEqual([other.key]);
            }
          }
          const queriedSibling = { ...other, label: "Queried sibling" };
          delayed.resolve({
            ...sessionsResult([{ ...initial }, queriedSibling], 30),
            totalCount: 40,
            hasMore: true,
            nextOffset: 10,
          });
          await refresh;
          const { permissionMode: initialMode, ...descriptor } = accepted;
          expect(list()).toMatchObject({
            totalCount: 40,
            hasMore: true,
            nextOffset: 10,
            sessions: [
              { ...descriptor, updatedAt: permission === undefined ? accepted.updatedAt : 30 },
              primaryPresent ? queriedSibling : other,
            ],
          });
          expect(row()?.permissionMode).toBe(
            permission === undefined ? initialMode : (permission ?? undefined),
          );
          if (permission === null) {
            expect(row()).not.toHaveProperty("permissionMode");
          }
        } else if (scenario === "deletion") {
          emitChange({
            key,
            sessionId: initial.sessionId,
            agentId: "main",
            reason: "delete",
          });
          expect(reconcile(accepted)).toBe(false);
          expect(sessions.state.result?.sessions).toEqual([]);
          expect(list()?.sessions).toEqual([]);
        } else {
          current = {
            ...initial,
            sessionId: "replacement-session",
            updatedAt: 5,
            label: "Newer managed child",
            placement: placement("offline"),
          };
          await sessions.refreshList({ ...query, force: true });
          const before = sessions.state.result;
          expect(reconcile(accepted)).toBe(false);
          expect(sessions.state.result).toBe(before);
          expect(row()).toMatchObject(current);
        }
      } finally {
        delayed.resolve(sessionsResult([initial], 30));
        await refresh;
      }
    },
  );

  it("coalesces changed-row query refreshes without refreshing ignored or unchanged rows", async () => {
    let current = initialChild;
    const request = vi.fn(async (method) => {
      return method === "sessions.describe"
        ? { session: current }
        : sessionsResult([current], current.updatedAt);
    });
    const { client, sessions, list, refresh } = setup(request, query);
    const readDescription = async () => {
      const reconcile = sessions.captureReconcile();
      const result = await client.request<{ session: typeof current }>("sessions.describe", {
        key,
      });
      expect(reconcile(result.session)).toBe(true);
    };
    await refresh();
    request.mockClear();
    current = { ...current, updatedAt: 20, label: "Updated child" };
    await readDescription();
    current = { ...current, updatedAt: 30, label: "Current child" };
    await readDescription();
    request.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(request).toHaveBeenCalledExactlyOnceWith(
      "sessions.list",
      expect.objectContaining(query),
    );
    expect(list()?.sessions[0]?.label).toBe(current.label);
    request.mockClear();

    sessions.reconcile(current);
    sessions.captureReconcile()(current);
    sessions.reconcile({ ...current, updatedAt: 10, label: "Older child" });
    sessions.reconcile(current, {
      modelProvider: "openai",
      model: "gpt-5.5",
      contextTokens: 128_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).not.toHaveBeenCalled();
    expect(sessions.state.result?.sessions[0]?.label).toBe(current.label);
  });

  it.each([false, true])(
    "publishes lineage without disturbing unchanged rows (archived: %s)",
    async (archived) => {
      const row = archived
        ? {
            ...child,
            key: "agent:main:archived-routed",
            sessionId: "session-routed",
            archived: true,
          }
        : child;
      const sessions = capabilityWithList(sessionsResult(archived ? [] : [row], 10));
      await sessions.refresh({ force: true });
      const published = vi.fn();
      if (!archived) {
        sessions.subscribe(published);
        const result = sessions.state.result;
        sessions.reconcile(row, result?.defaults, { resultAgentId: "main" });
        expect(sessions.state.result).toBe(result);
        expect(sessions.state.agentId).toBe("main");
        expect(published).toHaveBeenCalledOnce();
        published.mockClear();
      }
      const owner = publishLineage(sessions, row);
      expect(sessions.state.result?.sessions).toEqual([row]);
      if (!archived) {
        expect(owner.activeSessionLineageSelectedRow).toEqual(row);
        expect(published).not.toHaveBeenCalled();
      }
    },
  );
});
