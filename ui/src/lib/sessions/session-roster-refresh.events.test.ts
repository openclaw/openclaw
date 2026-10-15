// @vitest-environment jsdom
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { SessionsListParamsSchema } from "../../../../packages/gateway-protocol/src/schema/sessions-list.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createConnectionBootstrapCoordinator } from "../../app/connection-bootstrap.ts";
import { session } from "../../test-helpers/app-sidebar-cases/roster.test-support.ts";
import { createGatewayHarness } from "../../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createSessionCapability } from "./index.ts";
import {
  createGatewayHarness as createSessionGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

describe("session roster event traffic", () => {
  it("keeps 200-row shared and personal windows current without periodic reads of held rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const viewer = { type: "profile", id: "profile-ada" } as const;
    const actor = (id: string) => ({
      type: "human" as const,
      id,
      identity: { type: "profile" as const, id },
    });
    const rows: GatewaySessionRow[] = Array.from({ length: 270 }, (_, index) =>
      session("main", index < 250 ? 99_000 - index : 90_000 - index, {
        key: `agent:main:conversation-${index}`,
        sessionId: `conversation-${index}`,
        isMain: false,
        snapshotAt: 100_000,
        label: `Conversation ${index}`,
        lastMessagePreview: "Synthetic project update",
        owner: { actor: actor(index === 0 || index >= 250 ? viewer.id : "profile-sam") },
        participants: index === 0 || index >= 250 ? [] : [{ identity: viewer }],
        hiddenFromInvolvingMe: false,
        hasActiveRun: false,
        status: "done",
        unread: false,
        lastReadAt: 98_000,
      }),
    );
    const shared = { agentId: "main", limit: 200 };
    const personal = { ...shared, involvingMe: true };
    const reads = { shared: 0, personal: 0 };
    const bytes = { shared: 0, personal: 0 };
    const request = async (method: string, params?: unknown) => {
      expect(method).toBe("sessions.list");
      if (!Value.Check(SessionsListParamsSchema, params)) {
        throw new Error("Invalid sessions.list request");
      }
      const scope = params.involvingMe ? "personal" : "shared";
      const eligible = rows
        .filter(
          (row) =>
            !params.involvingMe ||
            (row.hiddenFromInvolvingMe === false &&
              (row.owner?.actor.identity?.id === viewer.id ||
                row.participants?.some(({ identity }) => identity.id === viewer.id))),
        )
        .toSorted((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
      const page = eligible.slice(0, params.limit);
      const ownerRows = params.ownerFirst
        ? eligible.filter((row) => row.owner?.actor.id === viewer.id && !page.includes(row))
        : [];
      const response = {
        ...sessionsResult([...page, ...ownerRows], Date.now()),
        totalCount: eligible.length,
        hasMore: true,
        nextOffset: 200,
        limitApplied: 200,
      } satisfies SessionsListResult;
      reads[scope]++;
      bytes[scope] += new TextEncoder().encode(JSON.stringify(response)).byteLength;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 200);
      });
      return response;
    };
    const harness = createGatewayHarness(createTestGatewayClient(request));
    harness.publish({ selfUser: { id: viewer.id, identity: viewer } });
    const sessions = createTestSessionCapability(harness.gateway);
    const stop = sessions.subscribeList(personal, () => {});
    const emit = (row: GatewaySessionRow) =>
      harness.publishEvent("sessions.changed", {
        reason: "patch",
        sessionKey: row.key,
        agentId: "main",
        session: row,
        ancestorSessions: [],
      });
    try {
      const bootstrap = [
        sessions.refresh({ ...shared, force: true }),
        sessions.refreshList(personal),
      ];
      await vi.advanceTimersByTimeAsync(200);
      await Promise.all(bootstrap);
      expect(sessions.state.result?.sessions).toHaveLength(220);
      expect(sessions.listSnapshot(personal).result?.sessions).toHaveLength(200);
      const bootReads = { ...reads };
      const bootBytes = { ...bytes };
      for (let index = 0; index < 1_200; index++) {
        const hot = index % 10;
        rows[hot] = {
          ...rows[hot]!,
          updatedAt: 100_001 + index,
          snapshotAt: Date.now() + 1,
          totalTokens: index + 1,
          unread: hot % 2 === 0,
          lastReadAt: hot % 2 === 0 ? 98_000 : 100_001 + index,
        };
        emit(rows[hot]!);
        await vi.advanceTimersByTimeAsync(100);
        if (index === 599) {
          expect(reads).toEqual(bootReads);
          expect(bytes).toEqual(bootBytes);
        }
      }
      expect(reads).toEqual({ shared: bootReads.shared + 1, personal: bootReads.personal + 1 });
      for (const scope of ["shared", "personal"] as const) {
        expect(bytes[scope] - bootBytes[scope]).toBeLessThan(2 * bootBytes[scope]);
      }
      for (const query of [shared, personal]) {
        const held = sessions.listSnapshot(query).result?.sessions ?? [];
        expect(held.slice(0, 10).map((row) => row.key)).toEqual(
          Array.from({ length: 10 }, (_, index) => `agent:main:conversation-${9 - index}`),
        );
        expect(held.find((row) => row.key === "agent:main:conversation-8")).toMatchObject({
          totalTokens: 1_199,
          unread: true,
          lastReadAt: 98_000,
        });
        expect(held.find((row) => row.key === "agent:main:conversation-9")).toMatchObject({
          totalTokens: 1_200,
          unread: false,
          lastReadAt: 101_200,
        });
      }
      // Explicit reads absorb the minute fallback before exercising membership changes.
      const fresh = [
        sessions.refresh({ ...shared, force: true }),
        sessions.refreshList({ ...personal, force: true }),
      ];
      await vi.advanceTimersByTimeAsync(200);
      await Promise.all(fresh);
      const settledReads = { ...reads };
      rows[8] = { ...rows[8]!, unread: false, lastReadAt: Date.now(), snapshotAt: Date.now() + 1 };
      emit(rows[8]!);
      for (const query of [shared, personal]) {
        expect(
          sessions.listSnapshot(query).result?.sessions.find((row) => row.key === rows[8]!.key),
        ).toMatchObject({
          unread: false,
          lastReadAt: Date.now(),
        });
      }
      expect(reads).toEqual(settledReads);
      rows[250] = { ...rows[250]!, updatedAt: 90_100, snapshotAt: Date.now() + 1 };
      emit(rows[250]!);
      await vi.advanceTimersByTimeAsync(5_200);
      expect(reads.shared).toBe(settledReads.shared);
      rows[250] = { ...rows[250]!, updatedAt: Date.now(), snapshotAt: Date.now() + 1 };
      emit(rows[250]!);
      await vi.advanceTimersByTimeAsync(5_200);
      expect(reads.shared).toBe(settledReads.shared + 1);
      expect(sessions.state.result?.sessions).toHaveLength(219);
      expect(
        sessions.state.result?.sessions.some((row) => row.key === "agent:main:conversation-199"),
      ).toBe(false);
      expect(sessions.listSnapshot(personal).result?.sessions[0]?.key).toBe(rows[250]!.key);
      for (const [index, patch] of [
        [0, { owner: { actor: actor("profile-sam") } }],
        [1, { hiddenFromInvolvingMe: true }],
        [2, { participants: [] }],
      ] satisfies Array<[number, Partial<GatewaySessionRow>]>) {
        const before = reads.personal;
        rows[index] = {
          ...rows[index]!,
          ...patch,
          updatedAt: Date.now(),
          snapshotAt: Date.now() + 1,
        };
        emit(rows[index]!);
        await vi.advanceTimersByTimeAsync(5_200);
        const held = sessions.listSnapshot(personal).result?.sessions ?? [];
        expect(reads.personal).toBe(before + 1);
        expect(held).toHaveLength(200);
        expect(held.some((row) => row.key === rows[index]!.key)).toBe(false);
      }
      const beforeUnknown = { ...reads };
      const unknown = session("main", Date.now(), {
        ...rows[3]!,
        key: "agent:main:new-conversation",
        sessionId: "new-conversation",
        updatedAt: Date.now(),
        snapshotAt: Date.now() + 1,
      });
      rows.push(unknown);
      emit(unknown);
      expect(
        sessions.listSnapshot(personal).result?.sessions.some((row) => row.key === unknown.key),
      ).toBe(false);
      await vi.advanceTimersByTimeAsync(5_200);
      expect(reads).toEqual({
        shared: beforeUnknown.shared + 1,
        personal: beforeUnknown.personal + 1,
      });
      expect(sessions.state.result?.sessions[0]?.key).toBe(unknown.key);
      expect(sessions.listSnapshot(personal).result?.sessions[0]?.key).toBe(unknown.key);
    } finally {
      stop();
      sessions.dispose();
      await vi.advanceTimersByTimeAsync(200);
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    "refills a promoted held row omitted by an overlapping 200-row response (personal: %s)",
    async (personal) => {
      vi.useFakeTimers();
      const viewer = { type: "profile", id: "profile-ada" } as const;
      const held = Array.from({ length: 200 }, (_, index) =>
        session("main", 10_000 - index, {
          key: `agent:main:held-${index}`,
          sessionId: `held-${index}`,
          isMain: false,
          participants: [{ identity: viewer }],
          hiddenFromInvolvingMe: false,
        }),
      );
      const incoming = session("main", 15_000, {
        ...held[0]!,
        key: "agent:main:incoming",
        sessionId: "incoming",
        updatedAt: 15_000,
      });
      const promoted = { ...held[199]!, updatedAt: 20_000, unread: true, snapshotAt: 30_000 };
      const page = (rows: GatewaySessionRow[]) => ({
        ...sessionsResult(rows, 1),
        totalCount: 201,
        hasMore: true,
        nextOffset: 200,
        limitApplied: 200,
      });
      const pending = createDeferred<SessionsListResult>();
      const request = vi.fn().mockResolvedValue(page([promoted, incoming, ...held.slice(0, 198)]));
      request.mockResolvedValueOnce(page(held));
      if (personal) {
        request.mockResolvedValueOnce(page(held));
      }
      request.mockReturnValueOnce(pending.promise);
      const harness = createGatewayHarness(createTestGatewayClient(request));
      harness.publish({ selfUser: { id: viewer.id, identity: viewer } });
      const sessions = createTestSessionCapability(harness.gateway);
      const query = { agentId: "main", limit: 200, ...(personal ? { involvingMe: true } : {}) };
      const stop = personal ? sessions.subscribeList(query, () => {}) : () => {};
      try {
        if (personal) {
          await sessions.refresh({ agentId: "main", limit: 200 });
        }
        await sessions.refreshList(query);
        const bootReads = request.mock.calls.length;
        const refresh = sessions.refreshList({ ...query, force: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(request).toHaveBeenCalledTimes(bootReads + 1);
        harness.publishEvent("sessions.changed", {
          reason: "patch",
          sessionKey: promoted.key,
          session: promoted,
          ancestorSessions: [],
        });
        pending.resolve(page([incoming, ...held.slice(0, 199)]));
        await refresh;
        expect(request).toHaveBeenCalledTimes(bootReads + 1);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(request).toHaveBeenCalledTimes(bootReads + 2);
        const result = sessions.listSnapshot(query).result;
        expect(result?.sessions).toHaveLength(200);
        expect(result?.sessions[0]).toMatchObject({
          key: promoted.key,
          updatedAt: 20_000,
          unread: true,
        });
        expect(result?.sessions[1]?.key).toBe(incoming.key);
        expect(result?.sessions.some((row) => row.key === held[198]!.key)).toBe(false);
      } finally {
        pending.resolve(page([]));
        stop();
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("catches up a retained managed window after an event overlaps its reconnect read", async () => {
    vi.useFakeTimers();
    const held = session("main", 1, {
      key: "agent:main:archived",
      sessionId: "archived",
      isMain: false,
      archived: true,
      label: "Previous connection",
      snapshotAt: 1,
    });
    const updated = {
      ...held,
      updatedAt: 2,
      snapshotAt: 2,
      label: "Current connection",
      unread: true,
    };
    const stale = createDeferred<SessionsListResult>();
    const managedReads = vi
      .fn()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue(sessionsResult([updated], 2));
    const oldClient = createTestGatewayClient(async () => sessionsResult([held], 1));
    const nextClient = createTestGatewayClient(async (method, params) => {
      expect(method).toBe("sessions.list");
      return Reflect.get(params ?? {}, "archived") === "all"
        ? managedReads()
        : sessionsResult([], 1);
    });
    const harness = createSessionGatewayHarness(oldClient);
    const sessions = createTestSessionCapability(harness.gateway);
    const query = { agentId: "main", archivedFilter: "all" as const };
    const stop = sessions.subscribeList(query, () => {});
    try {
      await sessions.refreshList(query);
      harness.publish(false);
      harness.publish(true, nextClient);
      await vi.advanceTimersByTimeAsync(0);
      expect(managedReads).toHaveBeenCalledOnce();
      harness.emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: { reason: "patch", sessionKey: held.key, session: updated, ancestorSessions: [] },
      });
      stale.resolve(sessionsResult([held], 1));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sessions.listSnapshot(query).result?.sessions).toEqual([updated]);
      expect(managedReads).toHaveBeenCalledTimes(2);
    } finally {
      stale.resolve(sessionsResult([], 1));
      stop();
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps dock snapshots out of ordinary roster membership without repeated list reads", async () => {
    vi.useFakeTimers();
    const held = session("main", 1, { sessionId: "held" });
    const dock = session("main", 2, {
      key: "agent:main:board-agent",
      sessionId: "board-agent",
      isDock: true,
    });
    const request = vi.fn(async () => sessionsResult([held], 1));
    const harness = createGatewayHarness(createTestGatewayClient(request));
    const sessions = createTestSessionCapability(harness.gateway);
    try {
      await sessions.refresh({ agentId: "main", excludeDock: true, force: true });
      harness.publishEvent("sessions.changed", {
        reason: "patch",
        sessionKey: dock.key,
        session: dock,
        ancestorSessions: [],
      });
      harness.publishEvent("sessions.changed", {
        reason: "patch",
        sessionKey: held.key,
        session: { ...held, updatedAt: 3, label: "Updated title" },
        ancestorSessions: [],
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(request).toHaveBeenCalledOnce();
      expect(sessions.state.result?.sessions).toEqual([
        { ...held, updatedAt: 3, label: "Updated title" },
      ]);
    } finally {
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    "recovers failed membership refreshes on the next keyed snapshot (managed: %s)",
    async (managed) => {
      vi.useFakeTimers();
      const held = session("main", 1, { sessionId: "held" });
      const updated = { ...held, updatedAt: 2 };
      const added = session("main", 3, { key: "agent:main:new", sessionId: "new" });
      let rows = [held];
      let fail = false;
      let reads = 0;
      const client = createTestGatewayClient(async (_method, params) => {
        const selected = (Reflect.get(params ?? {}, "archived") === "all") === managed;
        if (selected) {
          reads += 1;
          if (fail) {
            throw new Error("List unavailable");
          }
        }
        return sessionsResult(rows, 1);
      });
      const harness = createGatewayHarness(client);
      const sessions = createTestSessionCapability(harness.gateway);
      const query = { agentId: "main", ...(managed ? { archivedFilter: "all" as const } : {}) };
      const stop = managed ? sessions.subscribeList(query, () => {}) : () => {};
      try {
        await sessions.refresh({ agentId: "main", force: true });
        if (managed) {
          await sessions.refreshList(query);
        }
        fail = true;
        harness.publishEvent("sessions.changed", { reason: "stores" });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(sessions.listSnapshot(query).error).toBe("List unavailable");
        fail = false;
        rows = [added, updated];
        harness.publishEvent("sessions.changed", { reason: "patch", session: updated });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(reads).toBe(3);
        expect(sessions.listSnapshot(query).error).toBeNull();
        expect(sessions.listSnapshot(query).result?.sessions).toEqual(rows);
      } finally {
        stop();
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each(["child", "parent"])(
    "refreshes related parent facts when lineage is recorded on the %s row",
    async (lineage) => {
      vi.useFakeTimers();
      const parent = session("main", 10, {
        key: "agent:main:parent",
        sessionId: "parent",
        hasActiveSubagentRun: true,
        ...(lineage === "parent" ? { childSessions: ["agent:main:child"] } : {}),
      });
      const child = session("main", 20, {
        key: "agent:main:child",
        sessionId: "child",
        hasActiveRun: true,
        ...(lineage === "child" ? { spawnedBy: parent.key } : {}),
      });
      const stopped = { ...child, hasActiveRun: false, updatedAt: 30 };
      const finalRows = [stopped, { ...parent, hasActiveSubagentRun: false }];
      const request = vi
        .fn()
        .mockResolvedValueOnce(sessionsResult([child, parent], 1))
        .mockResolvedValue(sessionsResult(finalRows, 2));
      const harness = createGatewayHarness(createTestGatewayClient(request));
      const sessions = createTestSessionCapability(harness.gateway);
      try {
        await sessions.refresh({ agentId: "main", force: true });
        harness.publishEvent("sessions.changed", { reason: "patch", session: stopped });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(request).toHaveBeenCalledTimes(2);
        expect(sessions.state.result?.sessions).toEqual(finalRows);
      } finally {
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each(["enter", "unpin", "archive", "owner-prefix", "create", "unknown-mutation"])(
    "refreshes membership after %s changes its boundary",
    async (change) => {
      vi.useFakeTimers();
      const limited = change !== "create" && change !== "unknown-mutation";
      const entering = change === "enter" || !limited;
      const held = session("main", change === "unpin" || change === "owner-prefix" ? 10 : 40, {
        key: "agent:main:held",
        sessionId: "held",
        ...(change === "unpin" ? { pinned: true, pinnedAt: 5 } : {}),
      });
      const recent = session("main", 30, { key: "agent:main:recent", sessionId: "recent" });
      const boundary = session("main", 20, { key: "agent:main:boundary", sessionId: "boundary" });
      const incoming = session("main", 50, { key: "agent:main:incoming", sessionId: "incoming" });
      const next = entering
        ? incoming
        : {
            ...held,
            updatedAt: change === "owner-prefix" ? 50 : held.updatedAt,
            ...(change === "unpin" ? { pinned: false, pinnedAt: undefined } : {}),
            ...(change === "archive" ? { archived: true } : {}),
          };
      const initialRows = !limited
        ? [held]
        : change === "owner-prefix"
          ? [held, recent, boundary]
          : [held, recent];
      const finalRows = entering
        ? [next, held]
        : change === "owner-prefix"
          ? [next, recent]
          : [recent, boundary];
      const page = (rows: typeof initialRows) => ({
        ...sessionsResult(rows, 1),
        ...(limited ? { totalCount: 4, limitApplied: 2, nextOffset: 2, hasMore: true } : {}),
      });
      const request = vi
        .fn()
        .mockResolvedValueOnce(page(initialRows))
        .mockResolvedValue(page(finalRows));
      const gatewayHarness = createGatewayHarness(createTestGatewayClient(request));
      const sessions = createTestSessionCapability(gatewayHarness.gateway);
      try {
        await sessions.refresh({
          agentId: "main",
          ...(limited ? { limit: 2 } : {}),
          ownerFirst: change === "owner-prefix",
          force: true,
        });
        for (let index = 0; index < (limited ? 10 : 1); index += 1) {
          gatewayHarness.publishEvent("sessions.changed", {
            reason: limited ? "patch" : change,
            sessionKey: next.key,
            ...(limited ? { pinnedAt: null } : { ancestorSessions: [] }),
            session: next,
          });
        }
        if (!limited) {
          expect(sessions.listSnapshot({ agentId: "main" }).result?.sessions).toEqual(initialRows);
        }
        await vi.advanceTimersByTimeAsync(limited ? 20_000 : 5_000);
        expect(request).toHaveBeenCalledTimes(2);
        expect(sessions.state.result?.sessions).toEqual(finalRows);
        if (limited) {
          expect(sessions.state.result).toMatchObject({ hasMore: true, nextOffset: 2, count: 2 });
        } else {
          expect(sessions.listSnapshot({ agentId: "main" }).result?.sessions).toEqual(finalRows);
        }
      } finally {
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    "snapshot",
    "patch",
    "active-message",
    "terminal-message",
    "invalidation",
    "filtered",
    "all",
    "sessions-page",
    "dashboard",
  ])("bounds requests during a continuous %s stream for existing members", async (stream) => {
    vi.useFakeTimers();
    const row = session("main", 1, { sessionId: "tracked", hasActiveRun: true, hasBoard: true });
    let reads = 0;
    const client = createTestGatewayClient(async (method, params) => {
      expect(method).toBe("sessions.list");
      if (stream === "filtered" && !Reflect.get(params ?? {}, "search")) {
        return sessionsResult([], 0);
      }
      reads += 1;
      if (reads > 1) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1_000);
        });
      }
      return sessionsResult([row], reads);
    });
    const gatewayHarness = createGatewayHarness(client);
    const { gateway } = gatewayHarness;
    const sessions = createTestSessionCapability(gateway);
    const query = {
      agentId: "main",
      ...(stream === "filtered" ? { search: "tracked" } : {}),
      ...(stream === "all" ? { archivedFilter: "all" as const } : {}),
      ...(stream === "sessions-page"
        ? { includeDerivedTitles: false, includeLastMessage: false, includeUnknown: false }
        : {}),
      ...(stream === "dashboard" ? { hasBoard: true, archivedFilter: "all" as const } : {}),
    };
    const stop = ["filtered", "all", "sessions-page", "dashboard"].includes(stream)
      ? sessions.subscribeList(query, () => {})
      : () => {};
    try {
      if (["all", "sessions-page", "dashboard"].includes(stream)) {
        await sessions.refresh({ agentId: "main", force: true });
      }
      const initial = sessions.refreshList({ ...query, force: true });
      if (["all", "sessions-page", "dashboard"].includes(stream)) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await initial;
      const initialReads = reads;
      for (let index = 0; index < 600; index += 1) {
        gatewayHarness.publishEvent(
          stream.endsWith("-message") ? "session.message" : "sessions.changed",
          {
            sessionKey: row.key,
            agentId: "main",
            phase: "message",
            ...(stream === "snapshot" ? {} : { reason: stream }),
            ...(stream === "invalidation"
              ? {}
              : {
                  ancestorSessions: [],
                  session: {
                    ...row,
                    updatedAt: index + 2,
                    totalTokens: index + 1,
                    hasActiveRun: stream !== "terminal-message",
                  },
                }),
          },
        );
        await vi.advanceTimersByTimeAsync(100);
      }
      if (stream !== "invalidation" && stream !== "filtered") {
        expect(reads - initialReads).toBe(0);
        expect(sessions.listSnapshot(query).result?.sessions[0]?.totalTokens).toBe(600);
      } else {
        expect(reads - initialReads).toBeGreaterThan(1);
        expect(reads - initialReads).toBeLessThanOrEqual(15);
      }
    } finally {
      stop();
      sessions.dispose();
      await vi.advanceTimersByTimeAsync(1_000);
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    "rechecks page visibility after background admission (managed: %s)",
    async (managed) => {
      vi.useFakeTimers();
      const visibility = vi.spyOn(document, "visibilityState", "get");
      visibility.mockReturnValue("visible");
      const row = session("main", 1);
      const query = { agentId: "main", ...(managed ? { search: "tracked" } : {}) };
      const request = vi.fn(async () => sessionsResult([row], 1));
      const client = createTestGatewayClient(request);
      const gatewayHarness = createGatewayHarness(client);
      const { gateway } = gatewayHarness;
      const bootstrap = createConnectionBootstrapCoordinator();
      bootstrap.synchronize({ client, connected: true });
      const sessions = createSessionCapability(
        gateway,
        {
          state: { selectedId: "main" },
          subscribe: () => () => {},
        },
        { connectionBootstrap: bootstrap },
      );
      const stop = managed ? sessions.subscribeList(query, () => {}) : () => {};
      try {
        await sessions.refreshList({ ...query, force: true });
        bootstrap.setForegroundRoute("agent:main:chat");
        gatewayHarness.publishEvent("sessions.changed", { sessionKey: row.key, reason: "patch" });
        await vi.advanceTimersByTimeAsync(5_000);
        visibility.mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
        bootstrap.setForegroundPane({}, { sessionKey: "agent:main:chat", client, ready: true });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(request).toHaveBeenCalledTimes(1);
        visibility.mockReturnValue("visible");
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(0);
        expect(request).toHaveBeenCalledTimes(managed ? 3 : 2);
      } finally {
        stop();
        sessions.dispose();
        bootstrap.reset();
        visibility.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it.each(["explicit", "replacement", "reconnect"])(
    "lets %s refreshes bypass and absorb automatic backoff",
    async (intent) => {
      vi.useFakeTimers();
      let reads = 0;
      const row = session("main", 1);
      const client = createTestGatewayClient(async (method) => {
        if (method !== "sessions.list") {
          return {};
        }
        reads += 1;
        if (reads === 2) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 1_000);
          });
        }
        return sessionsResult([row], reads);
      });
      const gatewayHarness = createGatewayHarness(client);
      const { gateway } = gatewayHarness;
      const sessions = createTestSessionCapability(gateway);
      try {
        await sessions.refresh({ agentId: "main", force: true });
        gatewayHarness.publishEvent("sessions.changed", { sessionKey: row.key, reason: "patch" });
        await vi.advanceTimersByTimeAsync(6_000);
        expect(reads).toBe(2);
        gatewayHarness.publishEvent("sessions.changed", { sessionKey: row.key, reason: "patch" });
        if (intent === "reconnect") {
          gatewayHarness.publish({ phase: "reconnecting" });
          gatewayHarness.publish({ phase: "connected" });
          await vi.advanceTimersByTimeAsync(0);
        } else if (intent === "replacement") {
          await sessions.refreshReplacement();
        } else {
          await sessions.refresh({ agentId: "main", force: true });
        }
        expect(reads).toBe(3);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(reads).toBe(3);
      } finally {
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("keeps child windows on row events but refills when the Gateway retires an owner", async () => {
    vi.useFakeTimers();
    const parent = session("main", 1, {
      key: "agent:main:parent",
      sessionId: "parent",
      isMain: false,
      childOwnerSessionKeys: [],
      childSessions: ["agent:main:child"],
    });
    const child = session("main", 1, {
      key: "agent:main:child",
      sessionId: "child",
      isMain: false,
      parentSessionKey: parent.key,
      childOwnerSessionKeys: [parent.key],
    });
    let retired = false;
    const reads: Record<string, number> = {};
    const client = createTestGatewayClient(async (method, params) => {
      expect(method).toBe("sessions.list");
      const value = Reflect.get(params ?? {}, "spawnedBy");
      const owner = typeof value === "string" ? value : undefined;
      reads[owner ?? "primary"] = (reads[owner ?? "primary"] ?? 0) + 1;
      const rows = !owner ? [parent, child] : owner === parent.key && !retired ? [child] : [];
      return { ...sessionsResult(rows, 1), hasMore: false, totalCount: rows.length };
    });
    const harness = createGatewayHarness(client);
    const sessions = createTestSessionCapability(harness.gateway);
    const children = { spawnedBy: parent.key, includeGlobal: false, includeUnknown: false };
    const empty = { ...children, spawnedBy: child.key };
    const stops = [children, empty].map((query) => sessions.subscribeList(query, () => {}));
    try {
      await sessions.refresh({ agentId: "main", force: true });
      await sessions.refreshList(children);
      await sessions.refreshList(empty);
      const emit = (updatedAt: number) =>
        harness.publishEvent("sessions.changed", {
          reason: "patch",
          sessionKey: child.key,
          session: { ...child, updatedAt, childOwnerSessionKeys: retired ? [] : [parent.key] },
          ancestorSessions: [{ ...parent, updatedAt, childSessions: retired ? [] : [child.key] }],
        });
      emit(2);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(reads[parent.key]).toBe(1);
      expect(reads[child.key]).toBe(1);
      expect(sessions.listSnapshot(children).result?.sessions[0]?.updatedAt).toBe(2);
      retired = true;
      emit(3);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(reads[parent.key]).toBe(2);
      expect(reads[child.key]).toBe(1);
      expect(sessions.listSnapshot(children).result?.sessions).toEqual([]);
    } finally {
      stops.forEach((stop) => stop());
      sessions.dispose();
      vi.useRealTimers();
    }
  });
  it("retains owner counts for title updates but refreshes changed run contributions", async () => {
    vi.useFakeTimers();
    const row = {
      key: "agent:main:owned",
      sessionId: "owned-session",
      kind: "direct" as const,
      label: "Owned session",
      updatedAt: 1,
      hasActiveRun: false,
      status: "done" as const,
    };
    const other = { ...row, key: "agent:main:off-facet", sessionId: "off-facet" };
    const query = {
      includeOwnerSessionCounts: true,
      limit: 1,
      excludeCron: true,
      excludeSystem: true,
      excludeDock: true,
    };
    let running = 0;
    const summaryRequest = vi.fn();
    const request = vi.fn(async (method: string, params?: unknown) => {
      expect(method).toBe("sessions.list");
      if (!Value.Check(SessionsListParamsSchema, params)) {
        throw new Error("Invalid sessions.list request");
      }
      if (!params.includeOwnerSessionCounts) {
        return sessionsResult([row, other], 1);
      }
      summaryRequest(params);
      return {
        ...sessionsResult([row], 1),
        ownerSessionCounts: [{ profileId: "ada", open: 8, running }],
        totalCount: 8,
        hasMore: true,
        nextOffset: 1,
      } satisfies SessionsListResult;
    });
    const { gateway, emitEvent } = createSessionGatewayHarness(createTestGatewayClient(request));
    const sessions = createTestSessionCapability(gateway);
    const listener = vi.fn();
    const observation = sessions.observeList(query, listener);
    try {
      await observation.refresh();
      expect(sessions.state.result).toBeNull();
      expect(sessions.listSnapshot(query).result?.ownerSessionCounts).toEqual([
        { profileId: "ada", open: 8, running: 0 },
      ]);
      await sessions.refresh({ agentId: "main", force: true });
      for (let index = 0; index < 5; index += 1) {
        for (const held of [row, other]) {
          emitEvent({
            type: "event",
            event: "sessions.changed",
            payload: {
              sessionKey: held.key,
              agentId: "main",
              reason: "patch",
              ancestorSessions: [],
              session: { ...held, label: `Renamed ${index}`, updatedAt: index + 2 },
            },
          });
        }
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await vi.advanceTimersByTimeAsync(54_999);
      expect(summaryRequest).toHaveBeenCalledOnce();
      running = 1;
      emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: {
          sessionKey: row.key,
          agentId: "main",
          reason: "agent.run.started",
          phase: "start",
          runId: "new-run",
          ts: 50,
          session: {
            ...row,
            updatedAt: 50,
            hasActiveRun: true,
            status: "running",
            activeRunIds: ["new-run"],
          },
        },
      });
      expect(summaryRequest).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(summaryRequest).toHaveBeenCalledTimes(2);
      expect(summaryRequest).toHaveBeenLastCalledWith(expect.objectContaining(query));
      expect(sessions.listSnapshot(query).result?.ownerSessionCounts).toEqual([
        { profileId: "ada", open: 8, running: 1 },
      ]);
      expect(sessions.state.result?.ownerSessionCounts).toBeUndefined();
      // Descendant-only changes on a held conversation outside the facet page also change counts.
      for (const [index, hasActiveSubagentRun] of [true, false].entries()) {
        running = hasActiveSubagentRun ? 2 : 1;
        emitEvent({
          type: "event",
          event: "sessions.changed",
          payload: {
            sessionKey: other.key,
            agentId: "main",
            reason: "subagent",
            ancestorSessions: [],
            session: { ...other, updatedAt: 100 + index, hasActiveSubagentRun },
          },
        });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(summaryRequest).toHaveBeenCalledTimes(3 + index);
        expect(sessions.listSnapshot(query).result?.ownerSessionCounts).toEqual([
          { profileId: "ada", open: 8, running },
        ]);
      }
    } finally {
      observation.dispose();
      sessions.dispose();
      vi.useRealTimers();
    }
  });
});
