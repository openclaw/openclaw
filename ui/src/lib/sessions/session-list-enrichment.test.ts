import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

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
