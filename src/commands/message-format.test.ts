// Tests for CLI message text formatting helpers (renderMessageList, formatMessageCliText).
import { describe, expect, it } from "vitest";
import type { MessageActionPagination } from "../infra/outbound/message-action-runner.js";
import { formatMessageCliText } from "./message-format.js";

function readResultPayload(payload: unknown, pagination?: MessageActionPagination) {
  return {
    kind: "action" as const,
    channel: "matrix" as const,
    action: "read" as const,
    handledBy: "plugin" as const,
    payload,
    dryRun: false,
    ...(pagination ? { pagination } : {}),
  };
}

function pinsResultPayload(payload: unknown, pagination?: MessageActionPagination) {
  return {
    kind: "action" as const,
    channel: "matrix" as const,
    action: "list-pins" as const,
    handledBy: "plugin" as const,
    payload,
    dryRun: false,
    ...(pagination ? { pagination } : {}),
  };
}

function searchResultPayload(payload: unknown, pagination?: MessageActionPagination) {
  return {
    kind: "action" as const,
    channel: "discord" as const,
    action: "search" as const,
    handledBy: "plugin" as const,
    payload,
    dryRun: false,
    ...(pagination ? { pagination } : {}),
  };
}

function msg(id: string, ts: string, authorTag: string, content: string) {
  return { id, ts, authorTag, content };
}

function textJoined(lines: string[]): string {
  return lines.join("\n");
}

describe("formatMessageCliText displayLimit", () => {
  it("honors displayLimit for message read", () => {
    const messages = Array.from({ length: 40 }, (_, i) =>
      msg(`id-${i}`, `2026-01-01T00:00:0${i % 10}.000Z`, `user-${i}`, `text-${i}`),
    );

    const result = readResultPayload({ messages });
    const out = textJoined(formatMessageCliText(result, { displayLimit: 15 }));

    // Should include items within the limit
    expect(out).toContain("text-0");
    expect(out).toContain("text-14");
    // Should NOT include items beyond the limit
    expect(out).not.toContain("text-15");
  });

  it("honors displayLimit for list-pins", () => {
    const pins = Array.from({ length: 40 }, (_, i) =>
      msg(`pin-${i}`, `2026-01-01T00:00:0${i % 10}.000Z`, `user-${i}`, `pin-text-${i}`),
    );

    const result = pinsResultPayload({ pins });
    const out = textJoined(formatMessageCliText(result, { displayLimit: 15 }));

    expect(out).toContain("pin-text-0");
    expect(out).toContain("pin-text-14");
    expect(out).not.toContain("pin-text-15");
  });

  it("honors displayLimit for search", () => {
    const messages = Array.from({ length: 40 }, (_, i) =>
      msg(`id-${i}`, `2026-01-01T00:00:0${i % 10}.000Z`, `user-${i}`, `search-${i}`),
    );
    // Discord search returns messages as array-of-array
    const wrapped = messages.map((m) => [m]);

    const result = searchResultPayload({ results: { messages: wrapped } });
    const out = textJoined(formatMessageCliText(result, { displayLimit: 15 }));

    expect(out).toContain("search-0");
    expect(out).toContain("search-14");
    expect(out).not.toContain("search-15");
  });

  it("defaults to 25 when no displayLimit is provided", () => {
    const messages = Array.from({ length: 50 }, (_, i) =>
      msg(`id-${i}`, `2026-01-01T00:00:0${i % 10}.000Z`, `user-${i}`, `text-${i}`),
    );

    const result = readResultPayload({ messages });
    const out = textJoined(formatMessageCliText(result));

    expect(out).toContain("text-24");
    expect(out).not.toContain("text-25");
  });

  it("renders all rows when total is below displayLimit", () => {
    const messages = [
      msg("id-1", "2026-01-01T00:00:00.000Z", "alice", "hello"),
      msg("id-2", "2026-01-01T00:00:01.000Z", "bob", "world"),
    ];

    const result = readResultPayload({ messages });
    const out = textJoined(formatMessageCliText(result, { displayLimit: 30 }));

    expect(out).toContain("hello");
    expect(out).toContain("world");
  });
});

describe("renderPaginationHint", () => {
  it("emits hint with cursor when pagination.hasMore and nextCursor are set", () => {
    const messages = [msg("id-1", "2026-01-01T00:00:00.000Z", "alice", "hello")];
    const result = readResultPayload({ messages }, { hasMore: true, nextCursor: "next-token" });
    const out = textJoined(formatMessageCliText(result, { displayLimit: 5 }));

    expect(out).toContain("More results available");
    expect(out).toContain('--cursor "next-token"');
  });

  it("emits hint without cursor when pagination.hasMore is true but no nextCursor", () => {
    const messages = [msg("id-1", "2026-01-01T00:00:00.000Z", "alice", "hello")];
    const result = readResultPayload({ messages }, { hasMore: true });
    const out = textJoined(formatMessageCliText(result, { displayLimit: 5 }));

    expect(out).toContain("More results available");
    expect(out).not.toContain("--cursor");
  });

  it("emits hint for search action via pagination", () => {
    const messages = [msg("id-1", "2026-01-01T00:00:00.000Z", "alice", "hello")];
    const wrapped = messages.map((m) => [m]);
    const result = searchResultPayload(
      { results: { messages: wrapped } },
      { hasMore: true, nextCursor: "https://graph.microsoft.com/v1.0/..." },
    );
    const out = textJoined(formatMessageCliText(result, { displayLimit: 5 }));

    expect(out).toContain("More results available");
  });

  it("does NOT emit hint when pagination is undefined", () => {
    const messages = [msg("id-1", "2026-01-01T00:00:00.000Z", "alice", "hello")];
    const result = readResultPayload({ messages });
    const out = textJoined(formatMessageCliText(result, { displayLimit: 5 }));

    expect(out).not.toContain("More results available");
  });

  it("does NOT emit hint when pagination.hasMore is false", () => {
    const messages = [msg("id-1", "2026-01-01T00:00:00.000Z", "alice", "hello")];
    const result = readResultPayload({ messages }, { hasMore: false });
    const out = textJoined(formatMessageCliText(result, { displayLimit: 5 }));

    expect(out).not.toContain("More results available");
  });

  it("falls back to payload hasMore when pagination is undefined (legacy)", () => {
    const messages = [msg("id-1", "2026-01-01T00:00:00.000Z", "alice", "hello")];
    // no pagination field — fallback reads payload.hasMore
    const result = readResultPayload({ messages, hasMore: true });
    const out = textJoined(formatMessageCliText(result, { displayLimit: 5 }));

    expect(out).toContain("More results available");
    expect(out).not.toContain("--cursor");
  });
});
