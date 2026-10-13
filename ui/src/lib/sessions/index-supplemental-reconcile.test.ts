// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { publishActiveSessionLineage } from "../../components/app-sidebar-child-session-data.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

const key = "agent:main:device-session";

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
      vi.useFakeTimers();
      const initial = {
        key,
        sessionId: "session-device",
        kind: "direct" as const,
        updatedAt: 20,
        archived: false,
        modelProvider: "test-provider",
        model: "model-a",
        agentRuntime: { id: "runtime-a", source: "model" as const },
        thinkingLevels: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
        thinkingOptions: ["low", "high"],
        thinkingDefault: "high",
      };
      const selected = {
        modelProvider: initial.modelProvider,
        model: changedIdentity === "model" ? "model-b" : initial.model,
        agentRuntime: {
          id: changedIdentity === "runtime" ? "runtime-b" : initial.agentRuntime.id,
          source: "model" as const,
        },
      };
      const catalog = {
        ...initial,
        ...selected,
        thinkingLevels: [{ id: "medium", label: "Medium" }],
        thinkingOptions: ["medium"],
        thinkingDefault: "medium",
      };
      const delayed = createDeferred<ReturnType<typeof sessionsResult>>();
      let hold = false;
      let reply = initial;
      const client = createTestGatewayClient(async (method) => {
        expect(method).toBe("sessions.list");
        return hold ? delayed.promise : sessionsResult([{ ...reply }], 20);
      });
      const { gateway, emitEvent } = createGatewayHarness(client);
      const sessions = createTestSessionCapability(gateway);
      const options = { agentId: "main", includeLastMessage: true, force: true };
      let pending: Promise<void> | undefined;
      try {
        await sessions.refresh(options);
        hold = true;
        pending = sessions.refresh(options);
        emitEvent({
          type: "event",
          event: "sessions.changed",
          payload: {
            sessionKey: key,
            agentId: "main",
            sessionId: initial.sessionId,
            kind: "direct",
            reason: "patch",
            updatedAt: 20,
            archived: false,
            ...selected,
          },
        });
        const changed = sessions.state.result?.sessions[0];
        expect(changed).toMatchObject(selected);
        for (const field of ["thinkingLevels", "thinkingOptions", "thinkingDefault"] as const) {
          expect(changed).not.toHaveProperty(field);
        }

        delayed.resolve(sessionsResult([{ ...initial }], 20));
        await pending;
        const current = sessions.state.result?.sessions[0];
        expect.soft(current).toMatchObject(selected);
        for (const field of ["thinkingLevels", "thinkingOptions", "thinkingDefault"] as const) {
          expect.soft(current).not.toHaveProperty(field);
        }

        hold = false;
        reply = catalog;
        await sessions.refresh(options);
        const refreshed = sessions.state.result?.sessions[0];
        expect(refreshed).toMatchObject(selected);
        expect(refreshed?.thinkingLevels).toEqual(catalog.thinkingLevels);
        expect(refreshed?.thinkingOptions).toEqual(catalog.thinkingOptions);
        expect(refreshed?.thinkingDefault).toBe(catalog.thinkingDefault);
      } finally {
        delayed.resolve(sessionsResult([initial], 20));
        await pending;
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each(["sibling", "duplicate"] as const)(
    "keeps an earlier captured child read current after appending a %s page",
    async (page) => {
      vi.useFakeTimers();
      const initial = {
        key,
        sessionId: "session-device",
        kind: "direct" as const,
        updatedAt: 10,
        label: "Page one child",
      };
      const later =
        page === "duplicate"
          ? { ...initial, updatedAt: 30, label: "Discarded duplicate" }
          : {
              ...initial,
              key: "agent:main:sibling",
              sessionId: "session-sibling",
              label: "Page two sibling",
            };
      const request = vi.fn(async (method, params) => {
        expect(method).toBe("sessions.list");
        const offset = (params as { offset?: number }).offset;
        return {
          ...sessionsResult([{ ...(offset ? later : initial) }], offset ? 30 : 10),
          totalCount: 2,
          hasMore: !offset,
          nextOffset: offset ? null : 1,
        };
      });
      const sessions = createTestSessionCapability(
        createGatewayHarness(createTestGatewayClient(request)).gateway,
      );
      const query = { ownerId: "ada", agentId: "main", limit: 1 };
      const unsubscribe = sessions.subscribeList(query, () => {});
      try {
        await sessions.refresh({ force: true, agentId: "main" });
        await sessions.refreshList(query);
        const reconcile = sessions.captureReconcile();
        await sessions.refreshList({ ...query, append: true, offset: 1 });
        const listed = sessions.listSnapshot(query).result;
        expect(listed?.sessions[0]?.label).toBe(initial.label);
        expect(listed?.sessions.map((row) => row.key)).toEqual(
          page === "duplicate" ? [key] : [key, later.key],
        );
        const fresh = { ...initial, updatedAt: 20, label: "Accepted child" };
        expect(reconcile(fresh)).toBe(true);
        expect(sessions.listSnapshot(query).result).toMatchObject({
          totalCount: 2,
          hasMore: false,
          nextOffset: null,
          sessions: page === "duplicate" ? [fresh] : [fresh, later],
        });
      } finally {
        unsubscribe();
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    ...(["older response", "replacement", "deletion"] as const).map((scenario) => ({
      scenario,
      permission: undefined,
      primaryPresent: true,
    })),
    ...(["full", null] as const).flatMap((permission) =>
      [true, false].map((primaryPresent) => ({
        scenario: "older response" as const,
        permission,
        primaryPresent,
      })),
    ),
  ])(
    "preserves managed-row observation order across $scenario (permission: $permission, primary: $primaryPresent)",
    async ({ scenario, permission, primaryPresent }) => {
      vi.useFakeTimers();
      const initial = {
        key,
        kind: "direct" as const,
        sessionId: "session-device",
        updatedAt: 10,
        label: "Initial child",
        placement: placement("available"),
        permissionMode: "guarded" as const,
      };
      let current = initial;
      const sibling = {
        ...initial,
        key: "agent:main:sibling",
        sessionId: "session-sibling",
        label: "Initial sibling",
      };
      const delayed = createDeferred<ReturnType<typeof sessionsResult>>();
      let holdManaged = false;
      let omitPrimary = false;
      const request = vi.fn(async (method, params) => {
        expect(method).toBe("sessions.list");
        if (holdManaged && (params as { ownerId?: string }).ownerId) {
          return delayed.promise;
        }
        return sessionsResult(
          omitPrimary && !(params as { ownerId?: string }).ownerId
            ? [sibling]
            : [{ ...current }, ...(scenario === "older response" ? [sibling] : [])],
          current.updatedAt,
        );
      });
      const { gateway, emitEvent } = createGatewayHarness(createTestGatewayClient(request));
      const sessions = createTestSessionCapability(gateway);
      const query = { ownerId: "ada", agentId: "main" };
      const unsubscribe = sessions.subscribeList(query, () => {});
      let refresh: Promise<void> | undefined;
      try {
        await sessions.refresh({ force: true, agentId: "main" });
        await sessions.refreshList(query);
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
          expect(sessions.listSnapshot(query).result?.sessions[0]).toMatchObject(accepted);
          if (permission !== undefined) {
            emitEvent({
              type: "event",
              event: "sessions.changed",
              payload: {
                key,
                sessionId: initial.sessionId,
                updatedAt: 30,
                permissionMode: permission,
              },
            });
            expect(sessions.state.result?.sessions[0]?.permissionMode).toBe(
              permission ?? undefined,
            );
            if (!primaryPresent) {
              omitPrimary = true;
              await sessions.refresh({ agentId: "main", force: true });
              expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual([sibling.key]);
            }
          }
          const queriedSibling = { ...sibling, label: "Queried sibling" };
          delayed.resolve({
            ...sessionsResult([{ ...initial }, queriedSibling], 30),
            totalCount: 40,
            hasMore: true,
            nextOffset: 10,
          });
          await refresh;
          const { permissionMode: initialMode, ...descriptor } = accepted;
          expect(sessions.listSnapshot(query).result).toMatchObject({
            totalCount: 40,
            hasMore: true,
            nextOffset: 10,
            sessions: [
              { ...descriptor, updatedAt: permission === undefined ? accepted.updatedAt : 30 },
              primaryPresent ? queriedSibling : sibling,
            ],
          });
          expect(sessions.listSnapshot(query).result?.sessions[0]?.permissionMode).toBe(
            permission === undefined ? initialMode : (permission ?? undefined),
          );
          if (permission === null) {
            expect(sessions.listSnapshot(query).result?.sessions[0]).not.toHaveProperty(
              "permissionMode",
            );
          }
        } else if (scenario === "deletion") {
          emitEvent({
            type: "event",
            event: "sessions.changed",
            payload: {
              key,
              sessionId: initial.sessionId,
              agentId: "main",
              reason: "delete",
            },
          });
          expect(reconcile(accepted)).toBe(false);
          expect(sessions.state.result?.sessions).toEqual([]);
          expect(sessions.listSnapshot(query).result?.sessions).toEqual([]);
        } else {
          current = {
            ...initial,
            sessionId: scenario === "replacement" ? "replacement-session" : initial.sessionId,
            updatedAt: 5,
            label: "Newer managed child",
            placement: placement("offline"),
          };
          await sessions.refreshList({ ...query, force: true });
          const primary = sessions.state.result;
          expect(reconcile(accepted)).toBe(false);
          expect(sessions.state.result).toBe(primary);
          expect(sessions.listSnapshot(query).result?.sessions[0]).toMatchObject(current);
        }
      } finally {
        delayed.resolve(sessionsResult([initial], 30));
        await refresh;
        unsubscribe();
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("coalesces changed-row query refreshes without refreshing ignored or unchanged rows", async () => {
    vi.useFakeTimers();
    let current = {
      key,
      kind: "direct" as const,
      sessionId: "session-device",
      updatedAt: 10,
      label: "Initial child",
    };
    const request = vi.fn(async (method) => {
      return method === "sessions.describe"
        ? { session: current }
        : sessionsResult([current], current.updatedAt);
    });
    const client = createTestGatewayClient(request);
    const sessions = createTestSessionCapability(createGatewayHarness(client).gateway);
    const readDescription = async () => {
      const reconcile = sessions.captureReconcile();
      const result = await client.request<{ session: typeof current }>("sessions.describe", {
        key,
      });
      expect(reconcile(result.session)).toBe(true);
    };
    const query = { ownerId: "ada", agentId: "main" };
    const unsubscribe = sessions.subscribeList(query, () => {});
    try {
      await sessions.refresh({ force: true, agentId: "main" });
      await sessions.refreshList(query);
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
      expect(sessions.listSnapshot(query).result?.sessions[0]?.label).toBe(current.label);
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
    } finally {
      unsubscribe();
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("publishes an owner change but not unchanged lineage rows and defaults", async () => {
    const canonical = {
      key,
      kind: "direct" as const,
      sessionId: "session-device",
      updatedAt: 10,
    };
    const sessions = capabilityWithList(sessionsResult([canonical], 10));
    try {
      await sessions.refresh({ force: true });
      const published = vi.fn();
      sessions.subscribe(published);
      const result = sessions.state.result;
      sessions.reconcile(canonical, result?.defaults, { resultAgentId: "main" });
      expect(sessions.state.result).toBe(result);
      expect(sessions.state.agentId).toBe("main");
      expect(published).toHaveBeenCalledOnce();
      published.mockClear();
      const owner = {
        activeSessionLineageRoot: null,
        activeSessionLineageSelectedRow: null,
        childSessionRowsByParent: {},
        context: { sessions },
        sessionsResult: sessions.state.result,
      };

      publishActiveSessionLineage(
        owner,
        key,
        { rowsByParent: {}, topmostRow: canonical, lookupFailed: false },
        sessions.inheritRow,
        () => true,
      );

      expect(owner.activeSessionLineageSelectedRow).toEqual(canonical);
      expect(sessions.state.result?.sessions).toEqual([canonical]);
      expect(published).not.toHaveBeenCalled();
    } finally {
      sessions.dispose();
    }
  });

  it("publishes an archived lineage missing from a newer canonical list", async () => {
    const sessions = capabilityWithList(sessionsResult([], 10));
    await sessions.refresh({ force: true });
    const archived = {
      key: "agent:main:archived-routed",
      kind: "direct" as const,
      sessionId: "session-routed",
      updatedAt: 10,
      archived: true,
    };
    const owner = {
      activeSessionLineageRoot: null,
      activeSessionLineageSelectedRow: null,
      childSessionRowsByParent: {},
      context: { sessions },
      sessionsResult: sessions.state.result,
    };

    publishActiveSessionLineage(
      owner,
      archived.key,
      { rowsByParent: {}, topmostRow: archived, lookupFailed: false },
      sessions.inheritRow,
      () => true,
    );

    expect(sessions.state.result?.sessions).toEqual([archived]);
    sessions.dispose();
  });
});
