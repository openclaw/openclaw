import { describe, expect, it } from "vitest";
import { filterMessagesByRunId, matchesRunId } from "./chat.history-run-id-filter.js";

describe("filterMessagesByRunId", () => {
  const runIdA = "py-obsidian-1776455694-1b96751f";
  const runIdB = "py-mail-2001112233-deadbeef";

  const messagesMixed: unknown[] = [
    {
      role: "user",
      content: [{ type: "text", text: "seed prompt" }],
      __openclaw: { id: "m1", seq: 1 },
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `[INSTRUCTION_BUNDLE]\n[CREATE_PROJECT]...[/CREATE_PROJECT]\n[RUN_RESULT run_id=${runIdA} status=done]\n[/INSTRUCTION_BUNDLE]`,
        },
      ],
      __openclaw: { id: "m2", seq: 2 },
    },
    {
      role: "user",
      content: [{ type: "text", text: "unrelated later message" }],
      __openclaw: { id: "m3", seq: 3 },
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `[RUN_RESULT run_id=${runIdB} status=done]`,
        },
      ],
      __openclaw: { id: "m4", seq: 4 },
    },
  ];

  it("returns the input array unchanged when runId is not provided", () => {
    expect(filterMessagesByRunId(messagesMixed, undefined)).toBe(messagesMixed);
  });

  it("returns only messages whose JSON body contains the runId token", () => {
    const filtered = filterMessagesByRunId(messagesMixed, runIdA);
    expect(filtered).toHaveLength(1);
    expect((filtered[0] as { __openclaw: { id: string } }).__openclaw.id).toBe("m2");
  });

  it("isolates different runs in the same session", () => {
    const filteredA = filterMessagesByRunId(messagesMixed, runIdA);
    const filteredB = filterMessagesByRunId(messagesMixed, runIdB);
    expect(filteredA).not.toEqual(filteredB);
    expect(filteredA).toHaveLength(1);
    expect(filteredB).toHaveLength(1);
  });

  it("returns empty when runId does not appear in any message", () => {
    expect(filterMessagesByRunId(messagesMixed, "py-unknown-0000000000-aaaaaaaa")).toEqual([]);
  });

  it("matches the runId even when the marker sits far into a long content block", () => {
    // Marker lives after a multi-kilobyte prefix.  The chat.history handler
    // applies this filter before its sanitization / placeholder passes, so a
    // truncated tail in the response pipeline can never hide the match here.
    const prefix = "x".repeat(50_000);
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: `${prefix}\n[RUN_RESULT run_id=${runIdA}]` }],
        __openclaw: { id: "long", seq: 10 },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "no marker here" }],
        __openclaw: { id: "noise", seq: 11 },
      },
    ];
    const filtered = filterMessagesByRunId(messages, runIdA);
    expect(filtered).toHaveLength(1);
    expect((filtered[0] as { __openclaw: { id: string } }).__openclaw.id).toBe("long");
  });

  it("tolerates non-serializable message records by excluding them", () => {
    const cyclic: Record<string, unknown> = { role: "assistant" };
    cyclic.self = cyclic; // JSON.stringify throws on cycles
    const messages = [
      cyclic,
      {
        role: "assistant",
        content: [{ type: "text", text: `[RUN_RESULT run_id=${runIdA}]` }],
      },
    ];
    expect(matchesRunId(cyclic, runIdA)).toBe(false);
    const filtered = filterMessagesByRunId(messages, runIdA);
    expect(filtered).toHaveLength(1);
  });
});
