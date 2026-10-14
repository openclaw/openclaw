import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
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
