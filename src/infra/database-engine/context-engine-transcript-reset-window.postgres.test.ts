import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { SessionManager } from "../../plugin-sdk/agent-sessions.js";
import {
  readSessionTranscriptVisibleMessageDelta,
  type SessionTranscriptVisibleMessageDeltaParams,
} from "../../plugin-sdk/context-engine-transcript-runtime.js";
import { appendSessionTranscriptMessageByIdentity } from "../../plugin-sdk/session-transcript-runtime.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

async function drain(params: SessionTranscriptVisibleMessageDeltaParams) {
  const ids: string[] = [];
  let cursor = params.cursor;
  for (;;) {
    const next = await readSessionTranscriptVisibleMessageDelta({ ...params, cursor });
    if (next.kind !== "page") {
      throw new Error(`expected a transcript page, got ${next.kind}`);
    }
    ids.push(...next.entries.map((entry) => entry.entryId));
    cursor = next.cursor;
    if (!next.hasMore) {
      return ids;
    }
  }
}

describe.skipIf(!mixedAgentConnection)("PostgreSQL reset-window reads", () => {
  const fixture = useMixedAgentPair("postgres", "postgres");
  beforeAll(() => setRuntimeConfigSnapshot({}));
  it("drains retained-tail pages and the post-reset suffix", async () => {
    const target = {
      agentId: "main",
      env: process.env,
      sessionId: "preserve-tail",
      sessionKey: "agent:main:preserve-tail",
      storePath: path.join(fixture.root, "shared", "shared.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const toolResult = (toolCallId: string, text: string) =>
      ({
        role: "toolResult",
        toolCallId,
        toolName: "read",
        content: [{ type: "text", text }],
        isError: false,
      }) as const;
    const messages = [
      { role: "user", content: "q0" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a3" },
      { role: "user", content: "q4" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
        stopReason: "toolUse",
      },
      toolResult("call-1", "paired"),
      toolResult("orphan-call", "orphan"),
      { role: "assistant", content: "a8" },
      { role: "user", content: "q9" },
      { role: "assistant", content: "a10" },
    ] as const;
    for (const [index, message] of messages.entries()) {
      await appendSessionTranscriptMessageByIdentity({
        ...target,
        eventId: `old-${index}`,
        message,
      });
    }
    // A reset that keeps the tail from old-4, as a preserve-tail session reset records it.
    const manager = await SessionManager.openAsync(target, fixture.root);
    await manager.appendResetBoundaryAsync("idle", "old-4");
    await appendSessionTranscriptMessageByIdentity({
      ...target,
      eventId: "new-user",
      message: { role: "user", content: "new" },
    });

    await expect(drain({ ...target, maxMessages: 4 })).resolves.toEqual([
      ...Array.from({ length: 11 }, (_, index) => `old-${index}`),
      "new-user",
    ]);
    // The retained tail excludes the orphan result but keeps the paired tool call/result.
    await expect(drain({ ...target, maxMessages: 4, start: "reset-window" })).resolves.toEqual([
      "old-4",
      "old-5",
      "old-6",
      "old-8",
      "old-9",
      "old-10",
      "new-user",
    ]);
  });
});
