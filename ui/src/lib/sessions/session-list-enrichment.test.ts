import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
// @vitest-environment node
import { Value } from "typebox/value";
import { expect, it, vi } from "vitest";
import { SessionsListParamsSchema } from "../../../../packages/gateway-protocol/src/schema/sessions-list.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createSessionCapabilityHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";
import { requestSessionListParams } from "./session-requests.ts";
import { sessionRow as makeRow } from "./session-rpc.test-support.ts";

const sidebar = { rowMode: "sidebar" as const };
function revised(rows: GatewaySessionRow[], rowsRevision: string, ts = 1) {
  return { ...sessionsResult(rows, ts), rowsRevision };
}
function delta(
  rows: GatewaySessionRow[],
  revision: string,
  order: number[],
  baseRevision = "first",
) {
  return { ...revised(rows, revision, 2), rowsDelta: { baseRevision, order } };
}
function sidebarReader(
  request: Parameters<typeof createTestGatewayClient>[0],
  query: Parameters<typeof requestSessionListParams>[1] = sidebar,
) {
  const client = createTestGatewayClient(request);
  return () => requestSessionListParams(client, query, () => true);
}
function expectRevision(request: ReturnType<typeof vi.fn>, revision: string) {
  expect(request).toHaveBeenLastCalledWith(
    "sessions.list",
    expect.objectContaining({ ifRowsRevision: `delta:${revision}` }),
  );
}

it.each([undefined, 1])(
  "expands response-local sidebar facts before reconciliation (page size %s)",
  async (pageSize) => {
    const request = vi.fn(async (_method: string, raw?: unknown) => {
      const offset = Number(asOptionalRecord(raw)?.offset ?? 0);
      const actor = { type: "human", id: `profile-${offset}`, label: `Teammate ${offset}` };
      return {
        ...sessionsResult([{ ...makeRow(`thread-${offset}`), ...sidebar, sharedFacts: [0] }], 1),
        sharedFacts: [{ createdActor: actor, owner: { actor } }],
        hasMore: offset === 0,
        nextOffset: offset + 1,
      };
    });
    const result = await sidebarReader(request, { ...sidebar, limit: 2, pageSize })();
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
  const rows = Array.from({ length: 350 }, (_, index) => makeRow(`thread-${index}`));
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
  const { gateway } = createGatewayHarness(createTestGatewayClient(request));
  const sessions = createTestSessionCapability(gateway);
  let held: ReturnType<typeof sessionsResult> | null = null;
  const query = {
    limit: 300,
    pageSize: 100,
    archivedFilter: "all" as const,
    includeDerivedTitles: true,
    includeLastMessage: true,
  };
  const observer = sessions.observeList(query, (snapshot) => {
    held = snapshot.result;
  });
  for (revision of [1, 2]) {
    await observer.refresh();
    const result = sessions.listSnapshot(query).result;
    expect(result).toBe(held);
    expect(result?.sessions).toHaveLength(300);
    expect(result).toMatchObject({ hasMore: true, nextOffset: 300 });
    for (const row of result?.sessions ?? []) {
      expect(row.derivedTitle).toBe(`Title ${row.sessionId} v${revision}`);
      expect(row.lastMessagePreview).toBe(`Preview ${row.sessionId} v${revision}`);
    }
  }
});

it("reconstructs sidebar delta membership, order and facts before capability publication", async () => {
  const labelled = (id: string) => makeRow(id, { label: id, updatedAt: 1 });
  const [a, b, c, d] = [labelled("a"), labelled("b"), labelled("c"), labelled("d")] as const;
  const actor = { type: "human" as const, id: "new-owner", label: "New owner" };
  const owners = [{ actor: { type: "human", id: "new-owner" }, label: "Fresh facet" }];
  const renamed = { ...a, label: "Renamed", updatedAt: 2 };
  const request = vi.fn().mockResolvedValue(revised([a, b, c], "first"));
  const { sessions } = createSessionCapabilityHarness(request);
  const query = { agentId: "main", rowMode: "sidebar" as const };
  await sessions.refresh({ ...query, force: true });
  request.mockResolvedValue({
    ...delta([renamed, { ...d, sharedFacts: [0] }], "next", [2, 4, 3]),
    count: 3,
    totalCount: 19,
    sharedFacts: [{ owner: { actor } }],
    owners,
  });
  await sessions.refresh({ ...query, force: true });
  expectRevision(request, "first");
  expect(sessions.state.result).toMatchObject({
    count: 3,
    totalCount: 19,
    sessions: [c, { ...d, owner: { actor } }, renamed],
    owners,
  });
  expect(sessions.state.result).not.toHaveProperty("rowsDelta");
  expect(sessions.state.result).not.toHaveProperty("sharedFacts");
  expect(sessions.state.result?.sessions[1]).not.toHaveProperty("sharedFacts");
  request.mockResolvedValue(revised([b], "restarted", 3));
  await sessions.refresh({ ...query, force: true });
  expect(sessions.state.result?.sessions.map(({ key }) => key)).toEqual([b.key]);
  expectRevision(request, "next");
});

it.each([
  { baseRevision: "unknown", order: [0], message: "unknown row revision" },
  { baseRevision: "first", order: [1], message: "incomplete row delta" },
  { baseRevision: "first", order: [-1], message: "incomplete row delta" },
  { baseRevision: "first", order: [0.5], message: "incomplete row delta" },
])(
  "rejects a delta with $message without replacing its wire base",
  async ({ baseRevision, order, message }) => {
    const initial = makeRow("a");
    const request = vi.fn().mockResolvedValue(revised([initial], "first"));
    const { sessions } = createSessionCapabilityHarness(request);
    const query = { rowMode: "sidebar" as const, agentId: "main" };
    await sessions.list(query);
    request.mockResolvedValue(delta([], "bad", order, baseRevision));
    await expect(sessions.list(query)).rejects.toThrow(message);
    request.mockResolvedValue({
      ...revised([], "first", 3),
      rowsUnchanged: true,
    });
    expect((await sessions.list(query))?.sessions).toEqual([initial]);
    expectRevision(request, "first");
  },
);

it("applies an empty-row reorder/removal delta without collapsing cross-agent raw keys", async () => {
  const a = { key: "global", agentId: "alpha", sessionId: "a", kind: "global" as const };
  const b = { key: "global", agentId: "beta", sessionId: "b", kind: "global" as const };
  const removed = makeRow("removed", { key: "agent:alpha:removed" });
  const request = vi
    .fn()
    .mockResolvedValueOnce(revised([a, b, removed], "first"))
    .mockResolvedValueOnce({
      ...delta([], "next", [1, 0]),
      count: 2,
    });
  const read = sidebarReader(request);
  const initial = await read();
  const next = await read();
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
    return revised([makeRow(id)], id);
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
  const a = makeRow("a", { label: "Original" });
  const b = makeRow("b");
  const older = createDeferred<SessionsListResult>();
  const request = vi
    .fn()
    .mockResolvedValueOnce(revised([a], "first"))
    .mockReturnValueOnce(older.promise)
    .mockResolvedValueOnce({ ...delta([{ ...a, label: "Newer" }], "newer", [1]), ts: 3 });
  const read = sidebarReader(request);
  const initial = await read();
  const pending = read();
  expect((await read())?.sessions[0]?.label).toBe("Newer");
  older.resolve(delta([b], "older", [0, 1]));
  const completed = await pending;
  expect(completed?.sessions).toEqual([a, b]);
  expect(completed?.sessions[0]).toBe(initial?.sessions[0]);
});
