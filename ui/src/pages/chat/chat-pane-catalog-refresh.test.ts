import { describe, expect, it, vi } from "vitest";
import type { SessionsCatalogReadResult } from "../../../../packages/gateway-protocol/src/index.js";
import { loadCatalogRefreshPages } from "./chat-pane-catalog-refresh.ts";

function message(label: string, identified = true) {
  return {
    role: "assistant",
    content: [{ type: "text", text: label }],
    ...(identified ? { messageId: label } : {}),
  };
}

function page(labels: string[], nextCursor?: string): SessionsCatalogReadResult {
  return {
    hostId: "gateway:local",
    threadId: "thread-1",
    items: labels.map((text) => ({ id: text, type: "agentMessage", text })),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

describe("catalog refresh paging", () => {
  it("deduplicates occurrence-aware ID-less overlap", async () => {
    const current = [message("A", false), message("B", false)];
    const firstPage = page(["C", "B", "A"]);

    await expect(
      loadCatalogRefreshPages({
        current,
        firstPage,
        firstPageMessages: [message("A", false), message("B", false), message("C", false)],
        isCurrent: () => true,
        project: () => [],
        read: vi.fn(),
      }),
    ).resolves.toEqual({
      messages: [message("A", false), message("B", false), message("C", false)],
      nextCursor: undefined,
    });
  });

  it("bridges every page to the oldest retained row before publishing", async () => {
    const current = Array.from({ length: 100 }, (_, index) => message(String(index + 1)));
    const firstPage = page([], "page-2");
    const projections = new WeakMap<SessionsCatalogReadResult, unknown[]>();
    projections.set(
      firstPage,
      Array.from({ length: 50 }, (_, index) => message(String(index + 151))),
    );
    const read = vi.fn(async (cursor: string) => {
      const ranges: Record<string, [number, number, string?]> = {
        "page-2": [101, 150, "page-3"],
        "page-3": [51, 100, "page-4"],
        "page-4": [1, 50],
      };
      const [start, end, nextCursor] = ranges[cursor]!;
      const response = page([], nextCursor);
      projections.set(
        response,
        Array.from({ length: end - start + 1 }, (_, index) => message(String(start + index))),
      );
      return response;
    });

    const result = await loadCatalogRefreshPages({
      current,
      firstPage,
      firstPageMessages: projections.get(firstPage)!,
      isCurrent: () => true,
      project: (candidate) => projections.get(candidate) ?? [],
      read,
    });

    expect(result?.messages).toEqual(
      Array.from({ length: 200 }, (_, index) => message(String(index + 1))),
    );
    expect(result?.nextCursor).toBeUndefined();
    expect(read.mock.calls.map(([cursor]) => cursor)).toEqual(["page-2", "page-3", "page-4"]);
  });

  it("recognizes the oldest retained row inside a refreshed page", async () => {
    const current = Array.from({ length: 50 }, (_, index) => message(String(index + 1951)));
    const firstPage = page([], "page-2");
    const secondPage = page([], "page-3");
    const projections = new WeakMap<SessionsCatalogReadResult, unknown[]>();
    projections.set(
      firstPage,
      Array.from({ length: 50 }, (_, index) => message(String(index + 1952))),
    );
    projections.set(
      secondPage,
      Array.from({ length: 50 }, (_, index) => message(String(index + 1902))),
    );
    const read = vi.fn(async () => secondPage);

    const result = await loadCatalogRefreshPages({
      current,
      firstPage,
      firstPageMessages: projections.get(firstPage)!,
      isCurrent: () => true,
      project: (candidate) => projections.get(candidate) ?? [],
      read,
    });

    expect(result?.messages).toEqual(
      Array.from({ length: 100 }, (_, index) => message(String(index + 1902))),
    );
    expect(result?.nextCursor).toBe("page-3");
    expect(read).toHaveBeenCalledOnce();
  });
});
