import { describe, expect, it, vi } from "vitest";
// @vitest-environment node
import type { SessionsDeleteResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

type RpcHandler = () => unknown;

function createMutationHarness(handlers: Record<string, RpcHandler>) {
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    const handler = handlers[method];
    if (handler) {
      return await handler();
    }
    if (method === "sessions.list") {
      return sessionsResult([], 2);
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const gatewayHarness = createGatewayHarness(client);
  return {
    ...gatewayHarness,
    client,
    request,
    sessions: createTestSessionCapability(gatewayHarness.gateway),
  };
}

function reconnectSameClient(publish: (connected: boolean) => void) {
  publish(false);
  publish(true);
}

describe("session mutation reconnect truth", () => {
  it.each(["none", "before acknowledgement", "after acknowledgement"] as const)(
    "confirms only successful batch archives while pending tokens retain settlement (intervening read: %s)",
    async (interveningRead) => {
      const rows = ["accepted", "rejected"].map((id) => ({
        key: `agent:main:batch-${id}`,
        sessionId: id,
        kind: "direct" as const,
        archived: false,
      }));
      const result = {
        outcomes: [
          { ok: true, key: rows[0]!.key, agentId: "main" },
          {
            ok: false,
            key: rows[1]!.key,
            error: { code: "UNAVAILABLE", message: "Cleanup failed" },
          },
        ],
      };
      const response = createDeferred<typeof result>();
      const readResponse = createDeferred<ReturnType<typeof sessionsResult>>();
      let listCalls = 0;
      let failReadback = false;
      const { sessions } = createMutationHarness({
        "sessions.list": () => {
          listCalls += 1;
          if (listCalls === 2 && interveningRead === "after acknowledgement") {
            return readResponse.promise;
          }
          if (failReadback) {
            throw new Error("Archive list refresh unavailable");
          }
          return sessionsResult(
            rows.map((row) => ({ ...row })),
            1,
          );
        },
        "sessions.patchMany": () => response.promise,
      });
      let archive: ReturnType<typeof sessions.patchMany> | undefined;
      let reading: ReturnType<typeof sessions.refresh> | undefined;
      try {
        await sessions.refresh();
        const finishes = rows.map((row) => sessions.beginArchive(row.key, row.sessionId));
        archive = sessions.patchMany(
          rows.map((row) => ({ key: row.key, agentId: "main", expectedSessionId: row.sessionId })),
          { archived: true },
        );
        if (interveningRead !== "none") {
          reading = sessions.refresh({ force: true });
          if (interveningRead === "before acknowledgement") {
            await reading;
          }
          expect(sessions.state.result?.sessions.map((row) => row.archived)).toEqual([
            false,
            false,
          ]);
        }
        response.resolve(result);
        await expect(archive).resolves.toEqual(result);
        readResponse.resolve(
          sessionsResult(
            rows.map((row) => ({ ...row })),
            1,
          ),
        );
        await reading;
        failReadback = true;
        await expect(sessions.refreshReplacement("main")).resolves.toBeNull();
        expect(sessions.state.error).toContain("Archive list refresh unavailable");
        expect(sessions.state.result?.sessions.map((row) => row.archived)).toEqual([true, false]);
        expect(sessions.state.result?.sessions[0]?.archivedAt).toBeUndefined();
        expect(rows.map((row) => sessions.archiveVisibility(row.key))).toEqual([
          "pending",
          "pending",
        ]);
        finishes.forEach((finish) => finish?.());
        expect(rows.map((row) => sessions.archiveVisibility(row.key))).toEqual([
          "archived",
          undefined,
        ]);
        failReadback = false;
        await sessions.refresh({ force: true });
        expect(sessions.state.result?.sessions.map((row) => row.archived)).toEqual([false, false]);
        expect(rows.map((row) => sessions.archiveVisibility(row.key))).toEqual([
          undefined,
          undefined,
        ]);
      } finally {
        sessions.dispose();
        response.resolve(result);
        readResponse.resolve(sessionsResult([], 1));
        await Promise.allSettled([archive, reading]);
      }
    },
  );

  it.each([
    { readUpdatedAt: 30, archived: true },
    { readUpdatedAt: 40, archived: false },
  ])(
    "reconciles a single archive acknowledgement after an intervening read at $readUpdatedAt and failed readback",
    async ({ readUpdatedAt, archived }) => {
      const row = {
        key: "agent:main:archive-equal-time",
        sessionId: "archive-equal-time",
        kind: "direct" as const,
        archived: false,
        updatedAt: 30,
      };
      const result = {
        ok: true,
        path: "(multiple)",
        key: row.key,
        // A stored future timestamp survives the archive's earlier wall-clock time.
        entry: {
          sessionId: row.sessionId,
          updatedAt: 30,
          archivedAt: 20,
          archiveReason: "manual",
        },
      };
      const response = createDeferred<typeof result>();
      let listCalls = 0;
      let failReadback = false;
      const { sessions } = createMutationHarness({
        "sessions.list": () => {
          listCalls += 1;
          if (failReadback) {
            throw new Error("Archive list refresh unavailable");
          }
          return sessionsResult(
            [{ ...row, updatedAt: listCalls === 1 ? row.updatedAt : readUpdatedAt }],
            listCalls,
          );
        },
        "sessions.patch": () => response.promise,
      });
      let archive: ReturnType<typeof sessions.patch> | undefined;
      let finishArchive: (() => void) | null = null;
      try {
        await sessions.refresh({ force: true });
        finishArchive = sessions.beginArchive(row.key, row.sessionId);
        expect(finishArchive).not.toBeNull();
        archive = sessions.patch(
          row.key,
          { archived: true },
          { agentId: "main", expectedSessionId: row.sessionId },
        );
        await sessions.refresh({ force: true });
        expect(sessions.state.result?.sessions[0]).toMatchObject({
          archived: false,
          updatedAt: readUpdatedAt,
        });
        failReadback = true;
        response.resolve(result);
        await expect(archive).resolves.toEqual(result);
        expect(sessions.state.error).toContain("Archive list refresh unavailable");
        expect(sessions.state.result?.sessions[0]).toMatchObject({ archived });
        expect(sessions.state.result?.sessions[0]?.archivedAt).toBe(archived ? 20 : undefined);
        finishArchive?.();
        expect(sessions.archiveVisibility(row.key)).toBe(archived ? "archived" : undefined);
      } finally {
        finishArchive?.();
        sessions.dispose();
        response.resolve(result);
        await archive;
      }
    },
  );

  it.each([
    { olderArchived: false, latest: "acknowledgement" },
    { olderArchived: true, latest: "acknowledgement" },
    { olderArchived: false, latest: "event" },
    { olderArchived: true, latest: "event" },
  ] as const)(
    "keeps the newer $latest after a rowless archived=$olderArchived acknowledgement",
    async ({ olderArchived, latest }) => {
      const row = {
        key: "agent:main:archive-order",
        sessionId: "archive-order",
        kind: "direct" as const,
        archived: !olderArchived,
        updatedAt: 10,
      };
      const target = { key: row.key, agentId: "main", expectedSessionId: row.sessionId };
      const result = { outcomes: [{ ok: true, key: row.key, agentId: "main" }] };
      const olderResponse = createDeferred<typeof result>();
      let rows = [row];
      let calls = 0;
      const { sessions } = createMutationHarness({
        "sessions.list": () => sessionsResult(rows, 1),
        "sessions.patchMany": () => (++calls === 1 ? olderResponse.promise : result),
      });
      let older: Promise<unknown> | undefined;
      try {
        await sessions.refresh({ force: true, archivedFilter: "all" });
        older = sessions.patchMany([target], { archived: olderArchived });
        if (latest === "acknowledgement") {
          await sessions.patchMany([target], { archived: !olderArchived });
        } else {
          sessions.reconcileChanged(
            {
              ...row,
              sessionKey: row.key,
              archived: !olderArchived,
              archivedAt: olderArchived ? null : 30,
              updatedAt: 30,
              reason: "patch",
            },
            { archivedFilter: "all" },
          );
        }
        rows = [];
        await sessions.refresh({ force: true, archivedFilter: "all" });
        expect(sessions.state.result?.sessions).toEqual([]);
        expect(sessions.archiveVisibility(row.key)).toBe(olderArchived ? undefined : "archived");

        olderResponse.resolve(result);
        await older;
        expect(sessions.state.result?.sessions).toEqual([]);
        expect(sessions.archiveVisibility(row.key)).toBe(olderArchived ? undefined : "archived");
      } finally {
        sessions.dispose();
        olderResponse.resolve(result);
        await older;
      }
    },
  );

  it("confirms a replacement archive held only by a row observer", async () => {
    const previous = {
      key: "agent:main:archive-successor",
      sessionId: "archive-previous",
      kind: "direct" as const,
      archived: false,
      updatedAt: 10,
    };
    let rows = [previous];
    const { sessions, client } = createMutationHarness({
      "sessions.list": () => sessionsResult(rows, 1),
      "sessions.describe": () => ({
        session: { ...previous, sessionId: "archive-successor", updatedAt: 30 },
      }),
      "sessions.patchMany": () => ({
        outcomes: [{ ok: true, key: previous.key, agentId: "main" }],
      }),
    });
    const target = { key: previous.key, agentId: "main" };
    let observer: ReturnType<typeof sessions.observeRow> | undefined;
    try {
      await sessions.refresh({ force: true, archivedFilter: "all" });
      await sessions.patchMany([{ ...target, expectedSessionId: previous.sessionId }], {
        archived: true,
      });
      expect(sessions.archiveVisibility(previous.key)).toBe("archived");
      rows = [];
      await sessions.refresh({ force: true, archivedFilter: "all" });
      rows = [{ ...previous, sessionId: "archive-successor", updatedAt: 30 }];
      // The canonical list owns incarnation admission; a descriptor cannot replace it.
      expect(
        (await sessions.list({ agentId: "main", archivedFilter: "all" }))?.sessions[0]?.sessionId,
      ).toBe("archive-successor");
      rows = [];
      observer = sessions.observeRow(target, () => {});
      expect(observer.row).toBeNull();
      const reconcile = observer.captureReconcile();
      const described = await client.request<{ session: typeof previous }>(
        "sessions.describe",
        target,
      );
      expect(reconcile(described.session)).toMatchObject({
        status: "current",
        row: { sessionId: "archive-successor" },
      });
      expect(observer.row?.sessionId).toBe("archive-successor");
      expect(sessions.archiveVisibility(previous.key)).toBeUndefined();

      await sessions.patchMany([{ ...target, expectedSessionId: "archive-successor" }], {
        archived: true,
      });
      expect(observer.row?.archived).toBe(true);
      expect(sessions.archiveVisibility(previous.key)).toBe("archived");
    } finally {
      observer?.dispose();
      sessions.dispose();
    }
  });

  it.each(["acknowledgement", "event"] as const)(
    "retains a newer %s through a canonical read before an older batch completes",
    async (latest) => {
      const row = {
        key: "agent:main:archive-lineage",
        sessionId: "archive-lineage",
        kind: "direct" as const,
        archived: false,
        updatedAt: 10,
      };
      let offered: typeof row & { pinned: boolean; pinnedAt?: number } = { ...row, pinned: false };
      const result = { outcomes: [{ ok: true, key: row.key, agentId: "main" }] };
      const response = createDeferred<typeof result>();
      const { sessions } = createMutationHarness({
        "sessions.list": () => sessionsResult([{ ...offered }], offered.updatedAt),
        "sessions.patchMany": () => response.promise,
        "sessions.patch": () => ({
          ok: true,
          path: "(multiple)",
          key: row.key,
          entry: { sessionId: row.sessionId, updatedAt: 20, pinnedAt: 20 },
        }),
      });
      let archive: ReturnType<typeof sessions.patchMany> | undefined;
      try {
        await sessions.refresh({ force: true });
        archive = sessions.patchMany(
          [{ key: row.key, agentId: "main", expectedSessionId: row.sessionId }],
          { archived: true },
        );
        if (latest === "acknowledgement") {
          await sessions.patch(
            row.key,
            { archived: false, pinned: true },
            { agentId: "main", expectedSessionId: row.sessionId, deferListRefresh: true },
          );
        } else {
          sessions.reconcileChanged({
            ...row,
            sessionKey: row.key,
            reason: "patch",
            updatedAt: 20,
            archived: false,
            pinned: true,
            pinnedAt: 20,
          });
        }
        offered = { ...offered, updatedAt: 20, pinned: true, pinnedAt: 20 };
        await sessions.refresh({ force: true });
        response.resolve(result);
        await archive;
        expect(sessions.state.result?.sessions[0]).toMatchObject({
          archived: false,
          pinned: true,
          pinnedAt: 20,
        });
        expect(sessions.archiveVisibility(row.key)).toBeUndefined();
      } finally {
        sessions.dispose();
        response.resolve(result);
        await archive;
      }
    },
  );

  it("does not let a timestamp-old event raise a read's accepted writer fence", async () => {
    const row = {
      key: "agent:main:archive-old-event",
      sessionId: "archive-old-event",
      kind: "direct" as const,
      archived: false,
      updatedAt: 10,
    };
    let offered = row;
    const result = { outcomes: [{ ok: true, key: row.key, agentId: "main" }] };
    const response = createDeferred<typeof result>();
    const { sessions } = createMutationHarness({
      "sessions.list": () => sessionsResult([{ ...offered }], offered.updatedAt),
      "sessions.patchMany": () => response.promise,
    });
    let archive: ReturnType<typeof sessions.patchMany> | undefined;
    try {
      await sessions.refresh({ force: true });
      sessions.reconcileChanged({ ...row, sessionKey: row.key, reason: "patch", updatedAt: 30 });
      archive = sessions.patchMany(
        [{ key: row.key, agentId: "main", expectedSessionId: row.sessionId }],
        { archived: true },
      );
      offered = { ...row, updatedAt: 30 };
      await sessions.refresh({ force: true });
      sessions.reconcileChanged({ ...row, sessionKey: row.key, reason: "patch", updatedAt: 20 });
      response.resolve(result);
      await archive;
      expect(sessions.state.result?.sessions[0]?.archived).toBe(true);
      expect(sessions.archiveVisibility(row.key)).toBe("archived");
    } finally {
      sessions.dispose();
      response.resolve(result);
      await archive;
    }
  });

  it.each(["missing descriptor", "first descriptor", "canonical successor"] as const)(
    "reconciles a pre-ACK read returning a %s without confusing field and incarnation order",
    async (readKind) => {
      const row = {
        key: "agent:main:archive-read-fence",
        sessionId: "archive-read-fence",
        kind: "direct" as const,
        archived: false,
        pinned: true,
        pinnedAt: 10,
        updatedAt: 10,
      };
      const result = { outcomes: [{ ok: true, key: row.key, agentId: "main" }] };
      const response = createDeferred<typeof result>();
      const readResponse = createDeferred<typeof row | null>();
      let currentDescription: typeof row | undefined;
      let listCalls = 0;
      const { sessions, client } = createMutationHarness({
        "sessions.list": async () => {
          if (++listCalls === 1) {
            return sessionsResult([{ ...row }], 10);
          }
          if (readKind === "first descriptor" && listCalls === 2) {
            return sessionsResult([], 20);
          }
          const next = await readResponse.promise;
          return sessionsResult(next ? [next] : [], 30);
        },
        "sessions.describe": async () => ({
          session: currentDescription ?? (await readResponse.promise),
        }),
        "sessions.patchMany": () => response.promise,
      });
      const target = { key: row.key, agentId: "main" };
      let observer: ReturnType<typeof sessions.observeRow> | undefined;
      let archive: ReturnType<typeof sessions.patchMany> | undefined;
      let reading: Promise<unknown> | undefined;
      try {
        await sessions.refresh({ force: true });
        expect(sessions.state.result?.sessions[0]).toMatchObject({ pinned: true, pinnedAt: 10 });
        archive = sessions.patchMany([{ ...target, expectedSessionId: row.sessionId }], {
          archived: true,
        });
        if (readKind === "first descriptor") {
          await sessions.refresh({ force: true });
          expect(sessions.state.result?.sessions).toEqual([]);
        }
        observer = sessions.observeRow(target, () => {});
        if (readKind !== "canonical successor") {
          const reconcile = observer.captureReconcile();
          reading = client
            .request<{ session: typeof row | null }>("sessions.describe", target)
            .then((value) => reconcile(value.session ?? undefined));
        } else {
          reading = sessions.refresh({ force: true });
        }
        response.resolve(result);
        await expect(archive).resolves.toEqual(result);
        if (readKind === "first descriptor") {
          expect(observer.row).toBeNull();
          expect(sessions.archiveVisibility(row.key)).toBe("archived");
        } else {
          expect(observer.row).toMatchObject({ archived: true, pinned: false });
          expect(observer.row?.pinnedAt).toBeUndefined();
        }
        readResponse.resolve(
          readKind === "missing descriptor"
            ? null
            : readKind === "first descriptor"
              ? { ...row }
              : { ...row, sessionId: "successor", updatedAt: 30, pinnedAt: 30 },
        );
        await reading;
        if (readKind === "missing descriptor") {
          expect(observer.isCurrent()).toBe(true);
          expect(observer.row?.archived).toBe(true);
          const currentRead = observer.captureReconcile();
          const missing = await client.request<{ session: typeof row | null }>(
            "sessions.describe",
            target,
          );
          currentRead(missing.session ?? undefined);
          expect(observer.row).toBeNull();
        } else if (readKind === "first descriptor") {
          expect(observer.isCurrent()).toBe(true);
          expect(observer.row).toMatchObject({ archived: true, pinned: false });
          expect(observer.row?.pinnedAt).toBeUndefined();
          // A later authoritative read can report an external restore and re-pin.
          currentDescription = { ...row, updatedAt: 30, pinnedAt: 30 };
          const currentRead = observer.captureReconcile();
          const fresh = await client.request<{ session: typeof row | null }>(
            "sessions.describe",
            target,
          );
          currentRead(fresh.session ?? undefined);
          expect(observer.row).toMatchObject({ archived: false, pinned: true, pinnedAt: 30 });
          expect(sessions.archiveVisibility(row.key)).toBeUndefined();
        } else {
          expect(observer.isCurrent()).toBe(false);
          expect(observer.row).toBeNull();
          expect(sessions.state.result?.sessions[0]).toMatchObject({
            sessionId: "successor",
            archived: false,
            pinned: true,
            pinnedAt: 30,
          });
        }
      } finally {
        observer?.dispose();
        sessions.dispose();
        response.resolve(result);
        readResponse.resolve(null);
        await Promise.allSettled([archive, reading]);
      }
    },
  );

  it("retains confirmed archive fields in an invalidated descriptor after its refresh fails", async () => {
    vi.useFakeTimers();
    const row = {
      key: "agent:main:invalidated-archive",
      sessionId: "invalidated-archive",
      kind: "direct" as const,
      archived: false,
      pinned: true,
      pinnedAt: 10,
      updatedAt: 10,
    };
    const unrelated = { ...row, key: "agent:main:unrelated", sessionId: "unrelated" };
    const target = { key: row.key, agentId: "main" };
    const result = { outcomes: [{ ok: true, ...target }] };
    const response = createDeferred<typeof result>();
    const readResponse = createDeferred<{ session: typeof row | null }>();
    const describeDispatched = createDeferred();
    const { sessions, client, emitEvent } = createMutationHarness({
      "sessions.list": () => sessionsResult([{ ...row }, { ...unrelated }], 10),
      "sessions.patchMany": () => response.promise,
      "sessions.describe": () => {
        describeDispatched.resolve();
        return readResponse.promise;
      },
    });
    let reading: Promise<unknown> | undefined;
    let archive: ReturnType<typeof sessions.patchMany> | undefined;
    const invalidated = vi.fn(() => {
      const reconcile = observer.captureReconcile();
      reading = client
        .request<{ session: typeof row | null }>("sessions.describe", target)
        .then((value) => reconcile(value.session ?? undefined))
        .catch((error: unknown) => error);
    });
    const observer = sessions.observeRow(target, () => {}, { onInvalidate: invalidated });
    const otherObserver = sessions.observeRow({ key: unrelated.key, agentId: "main" }, () => {});
    try {
      await sessions.refresh({ force: true });
      expect(observer.row).toMatchObject(row);
      archive = sessions.patchMany([{ ...target, expectedSessionId: row.sessionId }], {
        archived: true,
      });
      emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: { ...target, sessionKey: row.key, sessionId: row.sessionId, reason: "patch" },
      });
      await describeDispatched.promise;
      expect(invalidated).toHaveBeenCalledTimes(1);
      expect(observer.row).toMatchObject(row);

      response.resolve(result);
      await expect(archive).resolves.toEqual(result);
      expect(sessions.state.result?.sessions[0]).toMatchObject({
        sessionId: row.sessionId,
        archived: true,
        pinned: false,
      });
      expect(sessions.state.result?.sessions[0]?.pinnedAt).toBeUndefined();
      expect(sessions.archiveVisibility(row.key)).toBe("archived");
      readResponse.reject(new Error("Descriptor refresh unavailable"));
      await expect(reading).resolves.toMatchObject({ message: "Descriptor refresh unavailable" });
      expect(otherObserver.row).toMatchObject(unrelated);
      expect(observer.isCurrent()).toBe(true);
      expect(observer.row).toMatchObject({
        sessionId: row.sessionId,
        archived: true,
        pinned: false,
      });
      expect(observer.row?.pinnedAt).toBeUndefined();
    } finally {
      try {
        observer.dispose();
        otherObserver.dispose();
        sessions.dispose();
        response.resolve(result);
        readResponse.resolve({ session: row });
        await Promise.allSettled([archive, reading]);
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("retires archive progress on disconnect without letting an old completion clear a retry", async () => {
    const key = "agent:main:archive-retry";
    const sessionId = "archive-retry";
    const { publish, sessions } = createMutationHarness({
      "sessions.list": () => sessionsResult([{ key, sessionId, kind: "direct" }], 1),
    });
    await sessions.refresh();
    const finishPrevious = sessions.beginArchive(key, sessionId);
    expect(finishPrevious).not.toBeNull();
    expect(sessions.archiveVisibility(key)).toBe("pending");
    expect(sessions.beginArchive(key, sessionId)).toBeNull();

    sessions.reconcileChanged({ key, sessionKey: key, archived: false, reason: "update" });
    expect(sessions.archiveVisibility(key)).toBe("pending");
    publish(false);
    expect(sessions.archiveVisibility(key)).toBeUndefined();
    publish(true);
    await waitForFast(() => expect(sessions.state.result).not.toBeNull());
    const finishRetry = sessions.beginArchive(key, sessionId);
    expect(finishRetry).not.toBeNull();
    finishPrevious?.();
    expect(sessions.archiveVisibility(key)).toBe("pending");
    sessions.reconcileChanged({
      key,
      sessionKey: key,
      sessionId,
      archived: true,
      archivedAt: 2,
      reason: "patch",
    });
    expect(sessions.archiveVisibility(key)).toBe("archived");
    finishRetry?.();
    expect(sessions.archiveVisibility(key)).toBe("archived");
    sessions.dispose();
  });

  it.each(["before-response", "after-response"] as const)(
    "retains a confirmed create across a same-client reconnect %s without stale publication",
    async (reconnectOrder) => {
      const createResponse = createDeferred<{ key: string }>();
      const { publish, request, sessions } = createMutationHarness({
        "sessions.create": () => createResponse.promise,
      });
      const created = vi.fn();
      sessions.subscribeCreated(created);

      const operation = sessions.create({ agentId: "main" });
      if (reconnectOrder === "before-response") {
        reconnectSameClient(publish);
        createResponse.resolve({ key: "agent:main:stale" });
      } else {
        // Resolving queues the RPC continuation; retire its epoch before that microtask runs.
        createResponse.resolve({ key: "agent:main:stale" });
        reconnectSameClient(publish);
      }

      await expect(operation).resolves.toBe("agent:main:stale");
      expect(created).not.toHaveBeenCalled();
      expect(sessions.state.error).toContain("completed on the previous connection");
      expect(
        request.mock.calls.filter(([method]) => method === "sessions.list").length,
      ).toBeGreaterThan(0);
      sessions.dispose();
    },
  );

  it("reports both confirmed completion and replacement refresh failure", async () => {
    const createResponse = createDeferred<{ key: string }>();
    let failRefresh = false;
    const { publish, sessions } = createMutationHarness({
      "sessions.create": () => createResponse.promise,
      "sessions.list": () => {
        if (failRefresh) {
          throw new Error("replacement roster unavailable");
        }
        return sessionsResult([], 1);
      },
    });

    const operation = sessions.create({ agentId: "main" });
    reconnectSameClient(publish);
    await waitForFast(() => expect(sessions.state.result).not.toBeNull());
    failRefresh = true;
    createResponse.resolve({ key: "agent:main:refresh-failed" });

    await expect(operation).resolves.toBe("agent:main:refresh-failed");
    expect(sessions.state.error).toContain("completed on the previous connection");
    expect(sessions.state.error).toContain("replacement roster unavailable");
    sessions.dispose();
  });

  it("does not carry a confirmed create into a different client owner", async () => {
    const createResponse = createDeferred<{ key: string }>();
    const { publish, request, sessions } = createMutationHarness({
      "sessions.create": () => createResponse.promise,
    });
    const created = vi.fn();
    sessions.subscribeCreated(created);

    const operation = sessions.create({ agentId: "main" });
    publish(false);
    publish(true, { request } as unknown as GatewayBrowserClient);
    createResponse.resolve({ key: "agent:main:other-gateway" });

    await expect(operation).resolves.toBeNull();
    expect(created).not.toHaveBeenCalled();
    expect(sessions.state.error).toBeNull();
    sessions.dispose();
  });

  it("revalidates the same-client owner after replacement reconciliation", async () => {
    const createResponse = createDeferred<{ key: string }>();
    const reconciliation = createDeferred<ReturnType<typeof sessionsResult>>();
    let listCalls = 0;
    const { publish, request, sessions } = createMutationHarness({
      "sessions.create": () => createResponse.promise,
      "sessions.list": () => {
        listCalls += 1;
        return listCalls === 2 ? reconciliation.promise : sessionsResult([], listCalls);
      },
    });
    const created = vi.fn();
    sessions.subscribeCreated(created);

    const operation = sessions.create({ agentId: "main" });
    reconnectSameClient(publish);
    await waitForFast(() => expect(listCalls).toBe(1));
    createResponse.resolve({ key: "agent:main:stale-owner" });
    await waitForFast(() => expect(listCalls).toBe(2));
    publish(false);
    publish(true, { request } as unknown as GatewayBrowserClient);
    reconciliation.resolve(sessionsResult([], 2));

    await expect(operation).resolves.toBeNull();
    expect(created).not.toHaveBeenCalled();
    expect(sessions.state.error).toBeNull();
    sessions.dispose();
  });

  it("keeps a rejected create uncertain across a same-client reconnect", async () => {
    const createResponse = createDeferred<{ key: string }>();
    const { publish, sessions } = createMutationHarness({
      "sessions.create": () => createResponse.promise,
    });

    const operation = sessions.create({ agentId: "main" });
    reconnectSameClient(publish);
    createResponse.reject(new Error("transport closed before response"));

    await expect(operation).resolves.toBeNull();
    expect(sessions.state.error).toBeNull();
    sessions.dispose();
  });

  it.each(["delete", "deleteMany"] as const)(
    "retains a confirmed %s across a same-client reconnect without stale deletion publication",
    async (operationName) => {
      const deleteResponse = createDeferred<SessionsDeleteResult>();
      const { publish, request, sessions } = createMutationHarness({
        "sessions.delete": () => deleteResponse.promise,
      });
      const key = "agent:main:deleted-on-previous-connection";

      const operation =
        operationName === "delete" ? sessions.delete(key) : sessions.deleteMany([{ key }]);
      reconnectSameClient(publish);
      const worktreePreserved = {
        id: "wt-busy",
        branch: "openclaw/busy",
        path: "/worktrees/busy",
        reason: "busy" as const,
      };
      deleteResponse.resolve({
        ok: true,
        key,
        deleted: true,
        archived: [],
        worktreePreserved,
      });

      await expect(operation).resolves.toEqual(
        operationName === "delete"
          ? { deleted: true, worktreePreserved }
          : { deleted: [key], errors: [], preservedWorktrees: [worktreePreserved] },
      );
      expect(sessions.state.deletedSessions).toEqual([]);
      expect(sessions.state.error).toContain("completed on the previous connection");
      expect(
        request.mock.calls.filter(([method]) => method === "sessions.list").length,
      ).toBeGreaterThan(0);
      sessions.dispose();
    },
  );

  it.each(["no-op", "transport rejection"] as const)(
    "keeps earlier confirmed batch deletions when a later %s follows reconnect",
    async (laterOutcome) => {
      const laterDelete = createDeferred<{ deleted: boolean }>();
      const error = new Error("transport closed before response");
      let deleteCalls = 0;
      const { publish, sessions } = createMutationHarness({
        "sessions.delete": () => {
          deleteCalls += 1;
          return deleteCalls === 1 ? { deleted: true } : laterDelete.promise;
        },
      });

      const operation = sessions.deleteMany([
        { key: "agent:main:confirmed" },
        { key: "agent:main:unchanged" },
      ]);
      await waitForFast(() => expect(deleteCalls).toBe(2));
      reconnectSameClient(publish);
      if (laterOutcome === "no-op") {
        laterDelete.resolve({ deleted: false });
      } else {
        laterDelete.reject(error);
      }

      await expect(operation).resolves.toEqual({
        deleted: ["agent:main:confirmed"],
        errors:
          laterOutcome === "no-op" ? [] : [{ target: { key: "agent:main:unchanged" }, error }],
        preservedWorktrees: [],
      });
      expect(sessions.state.deletedSessions).toEqual([]);
      expect(sessions.state.error).toContain("completed on the previous connection");
      sessions.dispose();
    },
  );
});
