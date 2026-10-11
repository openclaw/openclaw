// Tests parent-session fork facade storage-boundary behavior.
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, describe, expect, it } from "vitest";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { ModelSelectionLockedError } from "../../sessions/model-selection-error.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  forkSessionEntryFromParent,
  forkSessionFromParent,
  MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE,
  resolveParentForkDecision,
} from "./session-fork.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-fork-boundary-");

describe("forkSessionEntryFromParent", () => {
  it("rejects model-selection-locked parent context", async () => {
    const parentEntry = {
      sessionId: "locked-parent",
      modelSelectionLocked: true,
      updatedAt: 1,
    };
    await expect(
      resolveParentForkDecision({ parentEntry, storePath: "/tmp/unused-sessions.json" }),
    ).rejects.toThrow(MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE);
    await expect(
      forkSessionFromParent({
        agentId: "main",
        parentEntry,
        parentSessionKey: "agent:main:main",
        sessionKey: "agent:main:subagent:child",
        storePath: "/tmp/unused-sessions.json",
      }),
    ).rejects.toThrow(MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE);
  });

  it("rejects a newer locked parent alias shadowed by a stale canonical row", async () => {
    const root = sessionDirs.make();
    const storePath = path.join(root, "sessions.json");
    await replaceSessionEntry(
      { agentId: "main", sessionKey: "agent:main:main", storePath },
      { sessionId: "stale-canonical-parent", updatedAt: 1 },
    );
    await replaceSessionEntry(
      { agentId: "main", sessionKey: "main", storePath },
      {
        sessionId: "fresh-locked-parent",
        modelSelectionLocked: true,
        updatedAt: 2,
      },
    );

    const fork = forkSessionEntryFromParent({
      agentId: "main",
      fallbackEntry: { sessionId: "", updatedAt: 3 },
      parentSessionKey: "agent:main:main",
      parentStoreKeys: ["agent:main:main", "main"],
      sessionKey: "agent:main:subagent:child",
      storePath,
    });
    await expect(fork).rejects.toBeInstanceOf(ModelSelectionLockedError);
    await expect(fork).rejects.toThrow(MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE);
    expect(
      loadSessionEntry({ agentId: "main", sessionKey: "agent:main:subagent:child", storePath }),
    ).toBeUndefined();
  });

  it.each([{ fresh: true, side: true }])(
    "rejects post-usage transcript growth with freshness $fresh and selected side append $side",
    async ({ fresh, side }) => {
      const root = sessionDirs.make();
      const storePath = path.join(root, "sessions.json");
      const parentSessionKey = "agent:main:main";
      const sessionKey = "agent:main:subagent:child";
      const parentEntry = {
        sessionId: "parent-session",
        totalTokens: 80_000,
        totalTokensFresh: fresh,
        totalTokensVersion: 1 as const,
        updatedAt: 1,
      };
      const parentScope = {
        agentId: "main",
        sessionId: parentEntry.sessionId,
        sessionKey: parentSessionKey,
        storePath,
      };
      await replaceTranscriptEvents(parentScope, [
        {
          type: "session",
          version: 3,
          id: parentEntry.sessionId,
          timestamp: "2026-06-27T00:00:00.000Z",
          cwd: root,
        },
        {
          type: "message",
          id: "usage",
          parentId: null,
          timestamp: "2026-06-27T00:00:01.000Z",
          message: {
            role: "assistant",
            content: "latest model call",
            usage: {
              input: 12,
              output: 10_000,
              contextUsage: {
                state: "available",
                promptTokens: 70_000,
                totalTokens: 80_000,
              },
            },
          },
        },
      ]);
      await replaceSessionEntry(
        { agentId: "main", sessionKey: parentSessionKey, storePath },
        parentEntry,
      );
      await appendTranscriptMessage(parentScope, {
        eventId: "tool-call",
        parentId: "usage",
        message: {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: "tail-call",
              name: "exec",
              arguments: { command: "synthetic tail" },
            },
          ],
        },
      });
      const tailText = `large appended tool result ${"x".repeat(100_000)}`;
      await appendTranscriptMessage(parentScope, {
        eventId: "tail",
        parentId: "tool-call",
        message: {
          role: "toolResult",
          toolCallId: "tail-call",
          toolName: "exec",
          content: [{ type: "text", text: tailText }],
          isError: false,
        },
      });
      if (side) {
        // Imported transcripts can select side-appended context with a leaf control.
        const events = await loadTranscriptEvents(parentScope);
        for (const event of events) {
          if (isRecord(event) && (event.id === "tool-call" || event.id === "tail")) {
            event.appendMode = "side";
          }
        }
        await replaceTranscriptEvents(parentScope, events);
        await appendTranscriptEvent(parentScope, {
          type: "leaf",
          id: "selected-tail",
          parentId: "tail",
          targetId: "tail",
          appendParentId: "tail",
        });
      }
      const storedParent = loadSessionEntry({
        agentId: "main",
        sessionKey: parentSessionKey,
        storePath,
      });
      expect(storedParent).toMatchObject({
        totalTokens: 80_000,
        totalTokensFresh: fresh,
        totalTokensVersion: 1,
      });

      await expect(resolveParentForkDecision({ parentEntry, storePath })).resolves.toMatchObject({
        status: "skip",
        reason: "parent-too-large",
      });

      const result = await forkSessionEntryFromParent({
        agentId: "main",
        parentSessionKey,
        sessionKey,
        storePath,
        fallbackEntry: { sessionId: "", updatedAt: 2 },
      });
      const decision =
        result.status === "forked" || result.status === "skipped" ? result.decision : undefined;
      expect(result).toMatchObject({
        status: "skipped",
        reason: "decision-skip",
        decision: { status: "skip", reason: "parent-too-large", parentTokens: expect.any(Number) },
      });
      expect(decision?.parentTokens).toBeGreaterThan(100_000);
      expect(decision?.parentTokens).toBeLessThan(110_000);
    },
  );
});
