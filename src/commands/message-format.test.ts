import { describe, expect, it } from "vitest";
import type { MessageActionRunResult } from "../infra/outbound/message-action-runner.js";
import { formatMessageCliText } from "./message-format.js";

function buildMessages(count: number): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  for (let i = 0; i < count; i++) {
    out.push({
      id: `msg-${i}`,
      authorTag: `user${i}`,
      timestamp: `2026-05-07T00:00:${String(i).padStart(2, "0")}Z`,
      content: `body-marker-${i}-end`,
    });
  }
  return out;
}

function buildResult(action: string, payload: unknown): MessageActionRunResult {
  return {
    kind: "action",
    channel: action === "list-pins" ? "msteams" : "discord",
    action,
    handledBy: "plugin",
    payload,
    dryRun: false,
  } as MessageActionRunResult;
}

function countRowsInOutput(output: string[], totalCount: number): number {
  const joined = output.join("\n");
  let rendered = 0;
  for (let i = 0; i < totalCount; i++) {
    if (joined.includes(`body-marker-${i}-end`)) {
      rendered += 1;
    }
  }
  return rendered;
}

describe("formatMessageCliText display limit", () => {
  it("read: caps at 25 rows by default", () => {
    const result = buildResult("read", { messages: buildMessages(30) });
    expect(countRowsInOutput(formatMessageCliText(result), 30)).toBe(25);
  });

  it("read: honors displayLimit greater than 25", () => {
    const result = buildResult("read", { messages: buildMessages(30) });
    const out = formatMessageCliText(result, { displayLimit: 30 });
    expect(countRowsInOutput(out, 30)).toBe(30);
  });

  it("list-pins: caps at 25 rows by default and honors displayLimit", () => {
    const result = buildResult("list-pins", { pins: buildMessages(30) });
    expect(countRowsInOutput(formatMessageCliText(result), 30)).toBe(25);
    expect(countRowsInOutput(formatMessageCliText(result, { displayLimit: 30 }), 30)).toBe(30);
  });

  it("search: caps at 25 rows by default and honors displayLimit", () => {
    const messages = buildMessages(30).map((m) => [m]);
    const result = buildResult("search", { results: { messages } });
    expect(countRowsInOutput(formatMessageCliText(result), 30)).toBe(25);
    expect(countRowsInOutput(formatMessageCliText(result, { displayLimit: 30 }), 30)).toBe(30);
  });

  it("read: payload smaller than displayLimit renders all rows without error", () => {
    const result = buildResult("read", { messages: buildMessages(5) });
    expect(countRowsInOutput(formatMessageCliText(result, { displayLimit: 50 }), 5)).toBe(5);
  });
});

describe("formatMessageCliText pagination hint", () => {
  it("emits truncation hint when more rows exist than displayed", () => {
    const result = buildResult("read", { messages: buildMessages(40) });
    const joined = formatMessageCliText(result).join("\n");
    expect(joined).toContain("Showing 25 of 40");
  });

  it("surfaces hasMore as a pagination hint", () => {
    const result = buildResult("read", { messages: buildMessages(5), hasMore: true });
    const joined = formatMessageCliText(result).join("\n");
    expect(joined).toContain("More results available beyond this page");
  });

  it("surfaces nextBatch cursor as a generic hint", () => {
    const result = buildResult("read", {
      messages: buildMessages(5),
      nextBatch: "cursor-token-xyz",
    });
    const joined = formatMessageCliText(result).join("\n");
    expect(joined).toContain("More results available beyond this page");
  });

  it("surfaces @odata.nextLink as a generic hint", () => {
    const result = buildResult("list-pins", {
      pins: buildMessages(3),
      "@odata.nextLink": "https://graph.microsoft.com/...",
    });
    const joined = formatMessageCliText(result).join("\n");
    expect(joined).toContain("More results available beyond this page");
  });

  it("emits no hint when payload is fully shown and has no cursor metadata", () => {
    const result = buildResult("read", { messages: buildMessages(5) });
    const joined = formatMessageCliText(result).join("\n");
    expect(joined).not.toContain("Showing");
    expect(joined).not.toContain("More results available");
    expect(joined).not.toContain("Reached --limit");
  });

  it("emits a heuristic hint when provider returns exactly --limit rows", () => {
    // Discord-style: payload has no hasMore/cursor; array length equals requested limit
    const result = buildResult("read", { messages: buildMessages(50) });
    const joined = formatMessageCliText(result, { displayLimit: 50 }).join("\n");
    expect(joined).toContain("Reached --limit (50)");
  });
});
