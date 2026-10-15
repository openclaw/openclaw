import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
// @vitest-environment node
import { Value } from "typebox/value";
import { expect, it, vi } from "vitest";
import { SessionsListParamsSchema } from "../../../../packages/gateway-protocol/src/schema/sessions-list.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionsListResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createSessionCapabilityHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";
import { requestSessionListParams } from "./session-requests.ts";

it.each([undefined, 1])(
  "expands response-local sidebar facts before reconciliation (page size %s)",
  async (pageSize) => {
    const request = vi.fn(async (_method: string, raw?: unknown) => {
      const offset = Number(asOptionalRecord(raw)?.offset ?? 0);
      const actor = { type: "human", id: `profile-${offset}`, label: `Teammate ${offset}` };
      return {
        ...sessionsResult(
          [
            {
              key: `agent:main:thread-${offset}`,
              sessionId: `thread-${offset}`,
              kind: "direct",
              rowMode: "sidebar",
              sharedFacts: [0],
            },
          ],
          1,
        ),
        sharedFacts: [{ createdActor: actor, owner: { actor } }],
        hasMore: offset === 0,
        nextOffset: offset + 1,
      };
    });
    const result = await requestSessionListParams(
      createTestGatewayClient(request),
      { rowMode: "sidebar", limit: 2, pageSize },
      () => true,
    );
    expect(result?.sessions).toHaveLength(pageSize ? 2 : 1);
    for (const [index, row] of result!.sessions.entries()) {
      expect(row.createdActor).toEqual({
        type: "human",
        id: `profile-${index}`,
        label: `Teammate ${index}`,
      });
      expect(row.owner?.actor).toEqual(row.createdActor);
      expect(row).not.toHaveProperty("sharedFacts");
    }
    expect(result).not.toHaveProperty("sharedFacts");
  },
);

it("retains titles and previews throughout a bounded managed window and its refresh", async () => {
  let revision = 1;
  const rows = Array.from({ length: 350 }, (_, index) => ({
    key: `agent:main:thread-${index}`,
    sessionId: `thread-${index}`,
    kind: "direct" as const,
  }));
  const request = vi.fn(async (method: string, raw?: unknown) => {
    if (method !== "sessions.list") {
      return {};
    }
    const params = asOptionalRecord(raw);
    const offset = Number(params?.offset ?? 0);
    const limit = Number(params?.limit);
    const page = rows.slice(offset, offset + limit).map((row, index) =>
      Object.assign(
        {},
        row,
        { updatedAt: revision },
        index < 100
          ? {
              derivedTitle: `Title ${row.sessionId} v${revision}`,
              lastMessagePreview: `Preview ${row.sessionId} v${revision}`,
            }
          : {},
      ),
    );
    return {
      ...sessionsResult(page, revision),
      offset,
      limitApplied: limit,
      totalCount: rows.length,
      hasMore: offset + limit < rows.length,
      nextOffset: offset + limit,
    };
  });
  const gateway = createGatewayHarness(createTestGatewayClient(request));
  const sessions = createTestSessionCapability(gateway.gateway);
  let held: ReturnType<typeof sessionsResult> | null = null;
  const observer = sessions.observeList(
    {
      limit: 300,
      pageSize: 100,
      archivedFilter: "all",
      includeDerivedTitles: true,
      includeLastMessage: true,
    },
    (snapshot) => {
      held = snapshot.result;
    },
  );
  try {
    for (revision of [1, 2]) {
      await observer.refresh();
      const result = sessions.listSnapshot({
        limit: 300,
        pageSize: 100,
        archivedFilter: "all",
        includeDerivedTitles: true,
        includeLastMessage: true,
      }).result;
      expect(result).toBe(held);
      expect(result?.sessions).toHaveLength(300);
      expect(result).toMatchObject({ hasMore: true, nextOffset: 300 });
      for (const row of result?.sessions ?? []) {
        expect(row.derivedTitle).toBe(`Title ${row.sessionId} v${revision}`);
        expect(row.lastMessagePreview).toBe(`Preview ${row.sessionId} v${revision}`);
      }
    }
  } finally {
    observer.dispose();
  }
});

it("reconstructs sidebar delta membership, order and facts before capability publication", async () => {
  const row = (id: string) => ({
    key: `agent:main:${id}`,
    sessionId: id,
    kind: "direct" as const,
    label: id,
    updatedAt: 1,
  });
  const a = row("a");
  const b = row("b");
  const c = row("c");
  const d = row("d");
  const request = vi
    .fn()
    .mockResolvedValue({ ...sessionsResult([a, b, c], 1), rowsRevision: "first" });
  const { sessions } = createSessionCapabilityHarness(request);
  const query = { agentId: "main", rowMode: "sidebar" as const };
  await sessions.refresh({ ...query, force: true });
  request.mockResolvedValue({
    ...sessionsResult(
      [
        { ...a, label: "Renamed", updatedAt: 2 },
        { ...d, sharedFacts: [0] },
      ],
      2,
    ),
    count: 3,
    totalCount: 19,
    rowsRevision: "next",
    rowsDelta: { baseRevision: "first", order: [2, 4, 3] },
    sharedFacts: [{ owner: { actor: { type: "human", id: "new-owner", label: "New owner" } } }],
    owners: [{ actor: { type: "human", id: "new-owner" }, label: "Fresh facet" }],
  });
  await sessions.refresh({ ...query, force: true });
  expect(request).toHaveBeenLastCalledWith(
    "sessions.list",
    expect.objectContaining({ ifRowsRevision: "delta:first" }),
  );
  expect(sessions.state.result).toMatchObject({
    count: 3,
    totalCount: 19,
    sessions: [
      c,
      { ...d, owner: { actor: { type: "human", id: "new-owner", label: "New owner" } } },
      { ...a, label: "Renamed", updatedAt: 2 },
    ],
    owners: [{ actor: { type: "human", id: "new-owner" }, label: "Fresh facet" }],
  });
  expect(sessions.state.result).not.toHaveProperty("rowsDelta");
  expect(sessions.state.result).not.toHaveProperty("sharedFacts");
  expect(sessions.state.result?.sessions[1]).not.toHaveProperty("sharedFacts");
  request.mockResolvedValue({ ...sessionsResult([b], 3), rowsRevision: "restarted" });
  await sessions.refresh({ ...query, force: true });
  expect(sessions.state.result?.sessions.map(({ key }) => key)).toEqual([b.key]);
  expect(request).toHaveBeenLastCalledWith(
    "sessions.list",
    expect.objectContaining({ ifRowsRevision: "delta:next" }),
  );
});

it.each([
  { baseRevision: "unknown", order: [0], message: "unknown row revision" },
  { baseRevision: "first", order: [1], message: "incomplete row delta" },
  { baseRevision: "first", order: [-1], message: "incomplete row delta" },
  { baseRevision: "first", order: [0.5], message: "incomplete row delta" },
])(
  "rejects a delta with $message without replacing its wire base",
  async ({ baseRevision, order, message }) => {
    const row = { key: "agent:main:a", sessionId: "a", kind: "direct" as const };
    const request = vi
      .fn()
      .mockResolvedValue({ ...sessionsResult([row], 1), rowsRevision: "first" });
    const { sessions } = createSessionCapabilityHarness(request);
    const query = { rowMode: "sidebar" as const, agentId: "main" };
    await sessions.list(query);
    request.mockResolvedValue({
      ...sessionsResult([], 2),
      rowsRevision: "bad",
      rowsDelta: { baseRevision, order },
    });
    await expect(sessions.list(query)).rejects.toThrow(message);
    request.mockResolvedValue({
      ...sessionsResult([], 3),
      rowsRevision: "first",
      rowsUnchanged: true,
    });
    expect((await sessions.list(query))?.sessions).toEqual([row]);
    expect(request).toHaveBeenLastCalledWith(
      "sessions.list",
      expect.objectContaining({ ifRowsRevision: "delta:first" }),
    );
  },
);

it("applies an empty-row reorder/removal delta without collapsing cross-agent raw keys", async () => {
  const a = { key: "global", agentId: "alpha", sessionId: "a", kind: "global" as const };
  const b = { key: "global", agentId: "beta", sessionId: "b", kind: "global" as const };
  const removed = { key: "agent:alpha:removed", sessionId: "removed", kind: "direct" as const };
  const request = vi
    .fn()
    .mockResolvedValueOnce({ ...sessionsResult([a, b, removed], 1), rowsRevision: "first" })
    .mockResolvedValueOnce({
      ...sessionsResult([], 2),
      count: 2,
      rowsRevision: "next",
      rowsDelta: { baseRevision: "first", order: [1, 0] },
    });
  const client = createTestGatewayClient(request);
  const query = { rowMode: "sidebar" as const };
  const initial = await requestSessionListParams(client, query, () => true);
  const next = await requestSessionListParams(client, query, () => true);
  expect(next?.sessions).toEqual([b, a]);
  expect(next?.sessions[0]).toBe(initial?.sessions[1]);
  expect(next?.sessions[1]).toBe(initial?.sessions[0]);
  expect(next).not.toHaveProperty("rowsDelta");
});

it("keeps filtered pages independent and accepts full rows from a server that only understands revisions", async () => {
  const request = vi.fn(async (_method: string, raw?: unknown) => {
    if (!Value.Check(SessionsListParamsSchema, raw)) {
      throw new Error("Invalid closed sessions.list params");
    }
    const id = `${raw.ownerId ?? (raw.involvingMe ? "personal" : "all")}-${raw.offset ?? 0}`;
    return {
      ...sessionsResult([{ key: `agent:main:${id}`, sessionId: id, kind: "direct" as const }], 1),
      rowsRevision: id,
    };
  });
  const { gateway } = createGatewayHarness(createTestGatewayClient(request));
  const sessions = createTestSessionCapability(gateway);
  for (const query of [
    { ownerId: "ada" },
    { ownerId: "ada", offset: 200 },
    { involvingMe: true },
    { ownerId: "sam" },
  ]) {
    const scope = { ...query, rowMode: "sidebar" as const };
    const first = await sessions.list(scope);
    expect(request.mock.calls.at(-1)?.[1]).not.toHaveProperty("ifRowsRevision");
    expect((await sessions.list(scope))?.sessions).toEqual(first?.sessions);
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({
      ifRowsRevision: `delta:${first!.rowsRevision}`,
    });
  }
});

it("reconstructs parallel deltas against each request's captured raw rows", async () => {
  const a = { key: "agent:main:a", sessionId: "a", kind: "direct" as const, label: "Original" };
  const b = { key: "agent:main:b", sessionId: "b", kind: "direct" as const };
  const older = createDeferred<SessionsListResult>();
  const request = vi
    .fn()
    .mockResolvedValueOnce({ ...sessionsResult([a], 1), rowsRevision: "first" })
    .mockReturnValueOnce(older.promise)
    .mockResolvedValueOnce({
      ...sessionsResult([{ ...a, label: "Newer" }], 3),
      rowsRevision: "newer",
      rowsDelta: { baseRevision: "first", order: [1] },
    });
  const client = createTestGatewayClient(request);
  const query = { rowMode: "sidebar" as const };
  const initial = await requestSessionListParams(client, query, () => true);
  const pending = requestSessionListParams(client, query, () => true);
  expect((await requestSessionListParams(client, query, () => true))?.sessions[0]?.label).toBe(
    "Newer",
  );
  older.resolve({
    ...sessionsResult([b], 2),
    rowsRevision: "older",
    rowsDelta: { baseRevision: "first", order: [0, 1] },
  });
  const completed = await pending;
  expect(completed?.sessions).toEqual([a, b]);
  expect(completed?.sessions[0]).toBe(initial?.sessions[0]);
});
