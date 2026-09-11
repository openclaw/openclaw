// @vitest-environment node
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  publishActiveSessionLineage,
  publishActiveSessionRow,
} from "../../components/app-sidebar-child-session-data.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

const key = "agent:main:device-session";
const requireRecord = createRequireRecord("object", "expected-label");

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
  it.each(
    (["primary", "describe"] as const).flatMap((first) =>
      (["primary", "describe"] as const).map((completedFirst) => ({ first, completedFirst })),
    ),
  )(
    "orders equal-timestamp placement reads (first issued: $first, first completed: $completedFirst)",
    async ({ first, completedFirst }) => {
      const initial = {
        key,
        sessionId: "session-device",
        kind: "direct" as const,
        updatedAt: 10,
        label: "Earlier descriptor",
        placement: placement("available"),
      };
      const current = { ...initial, label: "Current descriptor", placement: placement("offline") };
      const listed = createDeferred<ReturnType<typeof sessionsResult>>();
      const described = createDeferred<{ session: typeof initial }>();
      const client = createTestGatewayClient(async (method) => {
        if (method === "sessions.list") {
          return listed.promise;
        }
        expect(method).toBe("sessions.describe");
        return described.promise;
      });
      const sessions = createTestSessionCapability(createGatewayHarness(client).gateway);
      const readDescription = async () => {
        const reconcile = sessions.captureReconcile();
        const result = await client.request<{ session: typeof initial }>("sessions.describe", {
          key,
        });
        return reconcile(result.session);
      };
      let primary: ReturnType<typeof sessions.refresh>;
      let supplemental: Promise<boolean>;
      if (first === "primary") {
        primary = sessions.refresh({ agentId: "main", force: true });
        supplemental = readDescription();
      } else {
        supplemental = readDescription();
        primary = sessions.refresh({ agentId: "main", force: true });
      }
      try {
        if (completedFirst === "primary") {
          listed.resolve(sessionsResult([first === "primary" ? initial : current], 10));
          await primary;
          described.resolve({ session: first === "primary" ? current : initial });
          await supplemental;
        } else {
          described.resolve({ session: first === "primary" ? current : initial });
          await supplemental;
          listed.resolve(sessionsResult([first === "primary" ? initial : current], 10));
          await primary;
        }
        expect(sessions.state.result?.sessions[0]).toMatchObject(current);
      } finally {
        sessions.dispose();
        listed.resolve(sessionsResult([initial], 10));
        described.resolve({ session: initial });
        await Promise.all([primary, supplemental]);
      }
    },
  );

  it.each(["unchanged", "older snapshot", "omitted title"] as const)(
    "preserves actual read observations for an %s descriptor",
    async (mode) => {
      vi.useFakeTimers();
      const initial = {
        key,
        sessionId: "session-device",
        kind: "direct" as const,
        updatedAt: 10,
        derivedTitle: "Saved title",
        status: "done" as const,
        hasActiveRun: false,
        activeRunIds: [],
      };
      const { derivedTitle: _title, ...withoutTitle } = initial;
      const observed =
        mode === "older snapshot"
          ? { ...initial, updatedAt: 1, derivedTitle: "Rejected title" }
          : mode === "omitted title"
            ? withoutTitle
            : { ...initial };
      const delayed = createDeferred<ReturnType<typeof sessionsResult>>();
      let hold = false;
      const client = createTestGatewayClient(async (method, params) => {
        if (method === "sessions.describe") {
          return { session: observed };
        }
        expect(method).toBe("sessions.list");
        return hold && (params as { ownerId?: string }).ownerId
          ? delayed.promise
          : sessionsResult([{ ...initial }], 10);
      });
      const sessions = createTestSessionCapability(createGatewayHarness(client).gateway);
      const query = { ownerId: "ada", agentId: "main" };
      const unsubscribe = sessions.subscribeList(query, () => {});
      let pending: Promise<void> | undefined;
      try {
        await sessions.refresh({ agentId: "main", force: true });
        await sessions.refreshList(query);
        hold = true;
        pending = sessions.refreshList({ ...query, force: true });
        const reconcile = sessions.captureReconcile();
        const reply = await client.request<{ session: typeof observed }>("sessions.describe", {
          key,
        });
        reconcile(reply.session);
        expect(sessions.state.result?.sessions[0]?.derivedTitle).toBe(initial.derivedTitle);
        delayed.resolve(
          sessionsResult(
            [
              {
                ...initial,
                derivedTitle: "Queried title",
                status: "running",
                hasActiveRun: true,
                activeRunIds: ["earlier-run"],
              },
            ],
            10,
          ),
        );
        await pending;
        expect(sessions.listSnapshot(query).result?.sessions[0]?.derivedTitle).toBe(
          mode === "unchanged" ? initial.derivedTitle : "Queried title",
        );
        expect(sessions.listSnapshot(query).result?.sessions[0]).toMatchObject(
          mode === "older snapshot"
            ? { status: "running", hasActiveRun: true, activeRunIds: ["earlier-run"] }
            : { status: "done", hasActiveRun: false, activeRunIds: [] },
        );
      } finally {
        delayed.resolve(sessionsResult([initial], 10));
        await pending;
        unsubscribe();
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each([false, true])(
    "preserves field provenance when a changed supplemental read includes enrichment: %s",
    async (includesEnrichment) => {
      vi.useFakeTimers();
      const initial = {
        key,
        sessionId: "session-device",
        kind: "direct" as const,
        updatedAt: 10,
        status: "done" as const,
        hasActiveRun: false,
        activeRunIds: [],
        derivedTitle: "Saved title",
        lastMessagePreview: "Saved preview",
      };
      const { derivedTitle: _title, lastMessagePreview: _preview, ...withoutEnrichment } = initial;
      const observed = {
        ...withoutEnrichment,
        status: "running" as const,
        hasActiveRun: true,
        activeRunIds: ["current-run"],
        ...(includesEnrichment
          ? { derivedTitle: "Observed title", lastMessagePreview: "Observed preview" }
          : {}),
      };
      const delayed = createDeferred<ReturnType<typeof sessionsResult>>();
      let hold = false;
      const client = createTestGatewayClient(async (method, params) => {
        expect(method).toBe("sessions.list");
        const options = requireRecord(params, "sessions.list params");
        if (options.limit === 1) {
          return sessionsResult([observed], 10);
        }
        return hold && options.ownerId ? delayed.promise : sessionsResult([{ ...initial }], 10);
      });
      const sessions = createTestSessionCapability(createGatewayHarness(client).gateway);
      const query = {
        ownerId: "ada",
        agentId: "main",
        includeDerivedTitles: true,
        includeLastMessage: true,
      };
      const unsubscribe = sessions.subscribeList(query, () => {});
      let pending: Promise<void> | undefined;
      try {
        await sessions.refresh({ agentId: "main", includeLastMessage: true, force: true });
        await sessions.refreshList(query);
        hold = true;
        pending = sessions.refreshList({ ...query, force: true });
        const reconcile = sessions.captureReconcile();
        const reply = await sessions.list({
          agentId: "main",
          limit: 1,
          includeDerivedTitles: includesEnrichment,
          includeLastMessage: includesEnrichment,
        });
        reconcile(reply?.sessions[0]);
        expect(sessions.state.result?.sessions[0]).toMatchObject({
          status: "running",
          derivedTitle: includesEnrichment ? "Observed title" : "Saved title",
          lastMessagePreview: includesEnrichment ? "Observed preview" : "Saved preview",
        });
        delayed.resolve(
          sessionsResult(
            [{ ...initial, derivedTitle: "Queried title", lastMessagePreview: "Queried preview" }],
            10,
          ),
        );
        await pending;
        expect(sessions.listSnapshot(query).result?.sessions[0]).toMatchObject({
          status: "running",
          hasActiveRun: true,
          activeRunIds: ["current-run"],
          derivedTitle: includesEnrichment ? "Observed title" : "Queried title",
          lastMessagePreview: includesEnrichment ? "Observed preview" : "Queried preview",
        });
      } finally {
        delayed.resolve(sessionsResult([initial], 10));
        await pending;
        unsubscribe();
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each(
    (["Event name", null] as const).flatMap((eventLabel) =>
      ([true, false] as const).map((readBeforeEvent) => ({ eventLabel, readBeforeEvent })),
    ),
  )(
    "orders explicit equal-clock event fields (label: $eventLabel, read issued before event: $readBeforeEvent)",
    async ({ eventLabel, readBeforeEvent }) => {
      vi.useFakeTimers();
      const initial = {
        key,
        sessionId: "session-device",
        kind: "direct" as const,
        updatedAt: 20,
        archived: false,
        label: "Old name",
        derivedTitle: "Saved title",
        lastMessagePreview: "Saved preview",
      };
      const delayed = createDeferred<ReturnType<typeof sessionsResult>>();
      let hold = false;
      const client = createTestGatewayClient(async (method) => {
        expect(method).toBe("sessions.list");
        return hold ? delayed.promise : sessionsResult([{ ...initial }], 20);
      });
      const { gateway, emitEvent } = createGatewayHarness(client);
      const sessions = createTestSessionCapability(gateway);
      const options = { agentId: "main", includeLastMessage: true, force: true };
      let pending: Promise<void> | undefined;
      try {
        await sessions.refresh(options);
        hold = true;
        if (readBeforeEvent) {
          pending = sessions.refresh(options);
        }
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
            label: eventLabel,
          },
        });
        expect(sessions.state.result?.sessions[0]?.label).toBe(eventLabel ?? undefined);
        if (!readBeforeEvent) {
          pending = sessions.refresh(options);
        }
        delayed.resolve(
          sessionsResult(
            [
              {
                ...initial,
                label: readBeforeEvent ? initial.label : "Read name",
                derivedTitle: "Queried title",
                lastMessagePreview: "Queried preview",
              },
            ],
            20,
          ),
        );
        await pending;
        const current = sessions.state.result?.sessions[0];
        expect(current).toMatchObject({
          derivedTitle: "Queried title",
          lastMessagePreview: "Queried preview",
        });
        if (readBeforeEvent && eventLabel === null) {
          expect(current).not.toHaveProperty("label");
        } else {
          expect(current?.label).toBe(readBeforeEvent ? eventLabel : "Read name");
        }
      } finally {
        delayed.resolve(sessionsResult([initial], 20));
        await pending;
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );

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
    ...(["older response", "newer observation", "replacement", "deletion"] as const).map(
      (scenario) => ({ scenario, permission: undefined, primaryPresent: true }),
    ),
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
      const sessions = createTestSessionCapability(
        createGatewayHarness(createTestGatewayClient(request)).gateway,
      );
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
            expect(
              sessions.reconcileChanged({
                key,
                sessionId: initial.sessionId,
                updatedAt: 30,
                permissionMode: permission,
              }).applied,
            ).toBe(true);
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
          sessions.reconcileChanged({
            key,
            sessionId: initial.sessionId,
            agentId: "main",
            reason: "delete",
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
    const retiredRevision = sessions.canonicalListRevision;
    try {
      await sessions.refresh({ force: true, agentId: "main" });
      await sessions.refreshList(query);
      request.mockClear();
      current = { ...current, updatedAt: 20, label: "Updated child" };
      await readDescription();
      current = { ...current, updatedAt: 30, label: "Current child" };
      await readDescription();
      request.mockClear();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(request).toHaveBeenCalledExactlyOnceWith(
        "sessions.list",
        expect.objectContaining(query),
      );
      expect(sessions.listSnapshot(query).result?.sessions[0]?.label).toBe(current.label);
      request.mockClear();

      sessions.reconcile(current);
      sessions.captureReconcile()(current);
      sessions.reconcile({ ...current, updatedAt: 10, label: "Older child" });
      sessions.reconcile({ ...current, updatedAt: 40, label: "Retired read" }, undefined, {
        sourceCanonicalListRevision: retiredRevision,
      });
      sessions.reconcile(current, {
        modelProvider: "openai",
        model: "gpt-5.5",
        contextTokens: 128_000,
      });
      await vi.advanceTimersByTimeAsync(1_000);
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
        sessions.canonicalListRevision,
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

  it("preserves a matching canonical row when history started before its list", async () => {
    const sessions = capabilityWithList(
      sessionsResult(
        [
          {
            key,
            kind: "direct",
            sessionId: "session-device",
            updatedAt: 10,
            placement: placement("offline"),
          },
        ],
        10,
      ),
    );
    const sourceCanonicalListRevision = sessions.canonicalListRevision;

    await sessions.refresh({ force: true });
    const published = vi.fn();
    sessions.subscribe(published);
    sessions.reconcile(
      {
        key,
        kind: "direct",
        sessionId: "session-device",
        updatedAt: 10,
        placement: placement("available"),
      },
      { modelProvider: "openai", model: "gpt-5.6-luna", contextTokens: 128_000 },
      { sourceCanonicalListRevision },
    );

    expect(sessions.state.result?.sessions[0]?.placement).toMatchObject({
      runner: { kind: "device", status: "offline" },
    });
    expect(sessions.state.result?.defaults).toMatchObject({
      modelProvider: "openai",
      model: "gpt-5.6-luna",
      contextTokens: 128_000,
    });
    expect(published).toHaveBeenCalledOnce();
    sessions.dispose();
  });

  it("adds a routed row absent from a newer canonical list", async () => {
    const sessions = capabilityWithList(sessionsResult([], 10));
    const sourceCanonicalListRevision = sessions.canonicalListRevision;

    await sessions.refresh({ force: true });
    sessions.reconcile(
      {
        key: "agent:main:archived-routed",
        kind: "direct",
        sessionId: "session-routed",
        updatedAt: 10,
        archived: true,
      },
      undefined,
      { archivedFilter: "all", sourceCanonicalListRevision },
    );

    expect(sessions.state.result?.sessions).toEqual([
      expect.objectContaining({
        key: "agent:main:archived-routed",
        archived: true,
        sessionId: "session-routed",
      }),
    ]);
    sessions.dispose();
  });

  it.each(["lineage", "child list"] as const)(
    "keeps a newer canonical placement when an older sidebar %s finishes",
    async (source) => {
      const canonical = {
        key,
        kind: "direct" as const,
        sessionId: "session-device",
        updatedAt: 10,
        placement: placement("offline"),
      };
      const sessions = capabilityWithList(sessionsResult([canonical], 10));
      const sourceCanonicalListRevision = sessions.canonicalListRevision;
      const reconcile = sessions.captureReconcile();
      await sessions.refresh({ force: true });
      const cached = {
        ...canonical,
        updatedAt: 20,
        derivedTitle: "My device session",
        lastMessagePreview: "Most recent message",
        placement: placement("available"),
      };
      const owner = {
        activeSessionLineageRoot: null,
        activeSessionLineageSelectedRow: cached,
        childSessionRowsByParent: { "agent:main:parent": [cached] },
        context: { sessions },
        sessionsResult: sessions.state.result,
      };

      if (source === "child list") {
        publishActiveSessionRow(owner, cached, reconcile, sessions.inheritRow, () => true);
      } else {
        publishActiveSessionLineage(
          owner,
          key,
          {
            rowsByParent: { "agent:main:parent": [cached] },
            topmostRow: cached,
            lookupFailed: false,
          },
          sourceCanonicalListRevision,
          sessions.inheritRow,
          () => true,
        );
      }

      expect(sessions.state.result?.sessions[0]?.placement).toEqual(placement("offline"));
      expect(owner.activeSessionLineageSelectedRow).toMatchObject({
        placement: placement("offline"),
        derivedTitle: "My device session",
        lastMessagePreview: "Most recent message",
      });
      expect(owner.childSessionRowsByParent["agent:main:parent"][0]).toMatchObject({
        placement: placement("offline"),
        derivedTitle: "My device session",
        lastMessagePreview: "Most recent message",
      });
      sessions.dispose();
    },
  );

  it("publishes an archived lineage missing from a newer canonical list", async () => {
    const sessions = capabilityWithList(sessionsResult([], 10));
    const sourceCanonicalListRevision = sessions.canonicalListRevision;
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
      sourceCanonicalListRevision,
      sessions.inheritRow,
      () => true,
    );

    expect(sessions.state.result?.sessions).toEqual([archived]);
    sessions.dispose();
  });
});
