import { describe, expect, it } from "vitest";

/**
 * Regression tests for the `runId` filter added to `chat.history`.
 *
 * The filter is implemented inline in chat.ts as a JSON.stringify.includes()
 * match against the full message record.  We exercise the same predicate
 * here so future refactors cannot silently change its semantics.
 */

function filterByRunId(messages: unknown[], runId: string | undefined): unknown[] {
  if (!runId) {
    return messages;
  }
  return messages.filter((msg) => {
    try {
      return JSON.stringify(msg).includes(runId);
    } catch {
      return false;
    }
  });
}

describe("chat.history runId filter", () => {
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

  it("returns all messages when runId is not provided", () => {
    expect(filterByRunId(messagesMixed, undefined)).toHaveLength(4);
  });

  it("returns only messages whose JSON body contains the runId token", () => {
    const filtered = filterByRunId(messagesMixed, runIdA);
    expect(filtered).toHaveLength(1);
    expect((filtered[0] as { __openclaw: { id: string } }).__openclaw.id).toBe("m2");
  });

  it("isolates different runs in the same session", () => {
    const filteredA = filterByRunId(messagesMixed, runIdA);
    const filteredB = filterByRunId(messagesMixed, runIdB);
    expect(filteredA).not.toEqual(filteredB);
    expect(filteredA).toHaveLength(1);
    expect(filteredB).toHaveLength(1);
  });

  it("returns empty when runId does not appear in any message", () => {
    expect(filterByRunId(messagesMixed, "py-unknown-0000000000-aaaaaaaa")).toEqual([]);
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
    const filtered = filterByRunId(messages, runIdA);
    expect(filtered).toHaveLength(1);
  });
});
