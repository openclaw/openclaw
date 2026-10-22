import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionCatalogTranscriptItem as TranscriptItem } from "../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntime } from "./runtime/types.js";
import {
  importSessionCatalogHistory,
  readBoundedSessionCatalogHistory,
  SESSION_CATALOG_TRANSCRIPT_IMPORT_LIMITS,
} from "./session-catalog-history-import.js";
import { listSessionCatalogEntries } from "./session-catalog.js";

const transcript = vi.hoisted(() => ({
  messages: [] as Array<Record<string, unknown>>,
  lockCalls: 0,
}));

// mock-isolation: Exercise catalog import ordering without opening the SQLite transcript owner.
vi.mock("../plugin-sdk/session-transcript-runtime.js", () => ({
  withSessionTranscriptWrite: async (
    _params: unknown,
    run: (context: {
      appendMessage: (params: {
        message: Record<string, unknown>;
        idempotencyLookup?: string;
        preparation?: { source?: () => void };
      }) => Promise<void>;
    }) => Promise<void>,
  ) => {
    transcript.lockCalls += 1;
    await run({
      appendMessage: async ({ message, idempotencyLookup, preparation }) => {
        const key = message.idempotencyKey;
        if (
          idempotencyLookup === "scan" &&
          typeof key === "string" &&
          transcript.messages.some((candidate) => candidate.idempotencyKey === key)
        ) {
          return;
        }
        preparation?.source?.();
        transcript.messages.push(message);
      },
    });
  },
}));

type CatalogItem = Parameters<Parameters<typeof importSessionCatalogHistory>[0]["read"]>[0];

function item(id: string, type: TranscriptItem["type"], text?: string): TranscriptItem {
  return { id, type, text };
}

function runtimeWithList() {
  const listSessionEntries = vi.fn((_params: { agentId: string }) => []);
  return {
    listSessionEntries,
    runtime: { agent: { session: { listSessionEntries } } } as unknown as PluginRuntime,
  };
}

function catalogReader(items: TranscriptItem[], maxPageSize = Number.POSITIVE_INFINITY) {
  return vi.fn(async ({ cursor, limit }: CatalogItem) => {
    const offset = cursor ? Number(cursor) : 0;
    const pageLimit = Math.min(limit, maxPageSize);
    const end = Math.max(0, items.length - offset);
    const start = Math.max(0, end - pageLimit);
    const page = items.slice(start, end).toReversed();
    const consumed = offset + page.length;
    return {
      hostId: "gateway",
      threadId: "thread-1",
      items: page,
      ...(consumed < items.length ? { nextCursor: String(consumed) } : {}),
    };
  });
}

function importHistory(
  items: TranscriptItem[],
  options: {
    continuationNotice?: string;
    commitGuard?: () => void;
    maxPageSize?: number;
    read?: ReturnType<typeof catalogReader>;
  } = {},
) {
  return importSessionCatalogHistory({
    catalogId: "pi",
    threadId: "thread-1",
    read: options.read ?? catalogReader(items, options.maxPageSize),
    sessionId: "session-1",
    sessionKey: "agent:main:catalog-adopt",
    agentId: "main",
    config: {},
    continuationNotice: options.continuationNotice,
    commitGuard: options.commitGuard,
  });
}

function messageText(message: Record<string, unknown>): string | undefined {
  if (typeof message.content === "string") {
    return message.content;
  }
  const content = Array.isArray(message.content) ? message.content[0] : undefined;
  return content && typeof content === "object" && "text" in content
    ? String(content.text)
    : undefined;
}

describe("listSessionCatalogEntries", () => {
  it("does not select a runtime catalog owner from retained migration metadata", () => {
    const config = retainLegacyDefaultAgentId(
      {
        agents: { entries: { alpha: {}, beta: {} } },
      } as OpenClawConfig,
      "beta",
    );
    const { listSessionEntries, runtime } = runtimeWithList();

    expect(() => listSessionCatalogEntries({ config, runtime })).toThrow(
      "session agent resolution has no explicit owner",
    );
    expect(listSessionEntries).not.toHaveBeenCalled();
  });

  it("requires and scopes an owner under explicit multi-agent ownership", () => {
    const config = {
      agents: {
        ownership: "explicit",
        entries: { alpha: {}, beta: {} },
      },
    } as OpenClawConfig;
    const { listSessionEntries, runtime } = runtimeWithList();

    expect(() => listSessionCatalogEntries({ config, runtime })).toThrow(
      "session agent resolution has no explicit owner",
    );
    expect(listSessionCatalogEntries({ agentId: "beta", config, runtime })).toEqual([]);
    expect(listSessionEntries).toHaveBeenCalledOnce();
    expect(listSessionEntries).toHaveBeenCalledWith({ agentId: "beta", readOnly: true });
  });
});

describe("importSessionCatalogHistory", () => {
  beforeEach(() => {
    transcript.messages.length = 0;
    transcript.lockCalls = 0;
  });

  it("imports newest-first pages in source order regardless of timestamps with native provenance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T12:00:00.000Z"));
    try {
      await importHistory(
        [
          { ...item("u-1", "userMessage", "repeat me"), timestamp: "not-a-date" },
          { ...item("u-2", "userMessage", "numeric year"), timestamp: "2026" },
          { ...item("u-3", "userMessage", "numeric zero"), timestamp: "0" },
          item("r-empty", "reasoning"),
          { ...item("r-1", "reasoning", "careful"), timestamp: "1969-12-31T23:59:59.000Z" },
          {
            ...item("a-1", "agentMessage", "answer"),
            model: "anthropic/claude",
            raw: "x".repeat(600 * 1024),
          },
          item("t-1", "toolCall", "bash"),
          item("o-1", "other", "checkpoint"),
        ],
        { maxPageSize: 2 },
      );
    } finally {
      vi.useRealTimers();
    }

    expect(transcript.messages.map(messageText)).toEqual([
      "repeat me",
      "numeric year",
      "numeric zero",
      "Thinking\n\ncareful",
      "answer",
      "Tool call\n\nbash",
      "Other\n\ncheckpoint",
    ]);
    expect(transcript.messages[0]?.["__openclaw"]).toEqual({ mirrorOrigin: "pi-catalog-import" });
    expect(transcript.messages.slice(0, 4).map((message) => message.timestamp)).toEqual([
      Date.parse("2026-07-25T12:00:00.000Z"),
      Date.parse("2026"),
      Date.parse("0"),
      -1_000,
    ]);
    expect(transcript.messages[4]?.model).toBe("anthropic/claude");
    expect(transcript.messages.map((message) => message.idempotencyKey)).toEqual(
      ["u-1", "u-2", "u-3", "r-1", "a-1", "t-1", "o-1"].map((id) => `pi-catalog:thread-1:${id}`),
    );
  });

  it("deduplicates a recovered import by scanning item idempotency keys", async () => {
    const items: TranscriptItem[] = [
      { id: "u-1", type: "userMessage", text: "hello" },
      { id: "a-1", type: "agentMessage", text: "hi" },
    ];

    await importHistory(items);
    await importHistory(items);

    expect(transcript.lockCalls).toBe(2);
    expect(transcript.messages).toHaveLength(2);
  });

  it("keeps only the most recent 200 items and returns them oldest-first", async () => {
    const items: TranscriptItem[] = Array.from({ length: 205 }, (_, index) => ({
      id: `item-${String(index)}`,
      type: "agentMessage",
      text: `message-${String(index)}`,
    }));

    const read = catalogReader(items);
    await importHistory(items, { read });

    expect(read).toHaveBeenCalledTimes(4);
    expect(transcript.messages).toHaveLength(200);
    expect(messageText(transcript.messages[0]!)).toBe("message-5");
    expect(messageText(transcript.messages.at(-1)!)).toBe("message-204");
  });

  it("keeps the recent suffix within the 512 KiB serialized-item budget", async () => {
    const items = Array.from({ length: 10 }, (_, index) =>
      item(`item-${index}`, "agentMessage", `${index}${"x".repeat(100 * 1024)}`),
    );

    await importHistory(items, { maxPageSize: 2 });

    expect(transcript.messages).toHaveLength(5);
    expect(messageText(transcript.messages[0]!)?.startsWith("5")).toBe(true);
    expect(messageText(transcript.messages.at(-1)!)?.startsWith("9")).toBe(true);
  });

  it("truncates a newest item that alone exceeds the byte budget", async () => {
    await importHistory([item("oversized", "toolResult", "x".repeat(600 * 1024))]);

    const text = messageText(transcript.messages[0]!);
    expect(text).toMatch(/^Tool result\n\n/u);
    expect(text).toMatch(/…$/u);
    expect(Buffer.byteLength(text ?? "", "utf8")).toBeLessThan(512 * 1024);
  });

  it("does not open the transcript write lock when a paged read fails", async () => {
    const read = vi
      .fn<Parameters<typeof importSessionCatalogHistory>[0]["read"]>()
      .mockResolvedValueOnce({
        hostId: "gateway",
        threadId: "thread-1",
        items: [item("a-1", "agentMessage", "latest")],
        nextCursor: "older",
      })
      .mockRejectedValueOnce(new Error("catalog read failed"));

    await expect(importHistory([], { read })).rejects.toThrow("catalog read failed");
    expect(transcript.lockCalls).toBe(0);
    expect(transcript.messages).toEqual([]);
  });

  it("appends one idempotent continuation notice under the caller authority guard", async () => {
    const commitGuard = vi.fn();
    const options = {
      continuationNotice: "Copied snapshot; using openai/gpt-5.6-sol.",
      commitGuard,
    };

    await importHistory([item("u-1", "userMessage", "Continue")], options);
    expect(commitGuard).toHaveBeenCalledTimes(2);
    await importHistory([item("u-1", "userMessage", "Continue")], options);
    expect(commitGuard).toHaveBeenCalledTimes(2);

    expect(transcript.messages.map(messageText)).toEqual([
      "Continue",
      "Copied snapshot; using openai/gpt-5.6-sol.",
    ]);
    expect(transcript.messages[1]).toMatchObject({
      provider: "openclaw",
      model: "session-catalog",
      idempotencyKey: "pi-catalog:thread-1:continuation-notice",
    });
    commitGuard.mockImplementation(() => {
      throw new Error("Catalog source revoked");
    });
    await expect(importHistory([item("u-2", "userMessage", "Refused")], options)).rejects.toThrow(
      "Catalog source revoked",
    );
    expect(transcript.messages).toHaveLength(2);
  });
});

describe("readBoundedSessionCatalogHistory", () => {
  it.each([
    ["cycle", [" A/+=? ", "B#/%", " A/+=? "]],
    ["repeated cursor", ["A", "A"]],
  ])("stops a %s after retaining its final page in source order", async (_name, cursors) => {
    const pages = cursors.map((nextCursor, index) => ({
      hostId: "gateway",
      threadId: "thread-1",
      items: [item(String(index), "userMessage", String(index))],
      nextCursor,
    }));
    let requests = 0;
    const read = vi.fn(async ({ cursor }: CatalogItem) => {
      const index = requests++;
      const page = pages[index];
      if (!page) {
        throw new Error("read past the repeated cursor");
      }
      expect(cursor).toBe(index === 0 ? undefined : cursors[index - 1]);
      return page;
    });

    const history = await readBoundedSessionCatalogHistory({
      read,
      limits: { maxItems: 10, maxBytes: 10_000 },
    });

    expect(read).toHaveBeenCalledTimes(pages.length);
    expect(history).toEqual({
      items: pages.flatMap((page) => page.items).toReversed(),
      totalItems: pages.length,
      complete: false,
    });
  });

  it.each([
    { terminal: false, finalItems: [] },
    { terminal: false, finalItems: [item("last", "userMessage", "last page")] },
    { terminal: true, finalItems: [item("last", "userMessage", "last page")] },
  ])("bounds sparse pages and reports completeness: %j", async ({ terminal, finalItems }) => {
    let requests = 0;
    const read = vi.fn(async () => {
      const count = ++requests;
      if (count > 3) {
        throw new Error("read past the request budget");
      }
      return {
        hostId: "gateway",
        threadId: "thread-1",
        items: count === 3 ? finalItems : [],
        ...(count === 3 && terminal ? {} : { nextCursor: `page-${count}` }),
      };
    });

    const history = await readBoundedSessionCatalogHistory({
      read,
      limits: { maxItems: 3, maxBytes: 10_000 },
    });

    expect(read).toHaveBeenCalledTimes(3);
    expect(history).toEqual({
      items: finalItems,
      totalItems: finalItems.length,
      complete: terminal,
    });
  });

  it("retains the import ceiling independently from the continuation seed and reports older history", async () => {
    const items: TranscriptItem[] = Array.from({ length: 50_001 }, (_, index) => ({
      type: "agentMessage",
      text: String(index),
    }));
    const history = await readBoundedSessionCatalogHistory({
      read: catalogReader(items),
      limits: SESSION_CATALOG_TRANSCRIPT_IMPORT_LIMITS,
    });

    expect(history.items).toHaveLength(50_000);
    expect(history.items[0]?.text).toBe("1");
    expect(history.items.at(-1)?.text).toBe("50000");
    expect(history.totalItems).toBe(50_000);
    expect(history.complete).toBe(false);
  });

  it("counts fetched items past a byte cutoff and distinguishes an exactly complete page", async () => {
    const items: TranscriptItem[] = [
      { type: "userMessage", text: "older" },
      { type: "userMessage", text: "newer" },
    ];
    const itemBytes = Buffer.byteLength(JSON.stringify(items[0]), "utf8");
    const read = catalogReader(items);

    expect(
      await readBoundedSessionCatalogHistory({
        read,
        limits: { maxItems: 2, maxBytes: 2 * itemBytes - 1 },
      }),
    ).toEqual({ items: [items[1]], totalItems: 2, complete: false });
    expect(
      await readBoundedSessionCatalogHistory({
        read,
        limits: { maxItems: 2, maxBytes: 2 * itemBytes },
      }),
    ).toEqual({ items, totalItems: 2, complete: true });
  });

  it("reports when the newest item itself must be truncated to fit", async () => {
    const history = await readBoundedSessionCatalogHistory({
      read: catalogReader([{ type: "toolResult", text: "🙂".repeat(100) }]),
      limits: { maxItems: 10, maxBytes: 100 },
    });

    expect(history).toMatchObject({ totalItems: 1, complete: false });
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({ type: "toolResult", truncated: true });
    expect(history.items[0]?.text).toMatch(/🙂…$/u);
    expect(Buffer.byteLength(JSON.stringify(history.items[0]), "utf8")).toBeLessThanOrEqual(100);
  });
});
