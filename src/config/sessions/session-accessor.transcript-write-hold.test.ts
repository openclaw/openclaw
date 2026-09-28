import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveZstdCodec } from "../../infra/zstd-codec.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { upsertSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.js";
import { persistSessionTranscriptTurn } from "./session-accessor.transcript-turn.js";

it.each(["authority", "idempotency"] as const)(
  "commits a %s-guarded turn without decoding unrelated tool results",
  async (guardKind) => {
    await withOpenClawTestState({ label: "guarded-turn-write-hold" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "guarded-turn",
        sessionKey: "agent:main:guarded-turn",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      appendTranscriptMessageSync(scope, {
        message: {
          role: "toolResult",
          toolCallId: "large-result",
          toolName: "read",
          content: [{ type: "text", text: "synthetic tool output ".repeat(8000) }],
          isError: false,
          timestamp: 1,
        },
      });
      const codec = resolveZstdCodec();
      if (!codec) {
        throw new Error("Transcript hold regression requires native zstd support");
      }
      const decode = vi.spyOn(codec, "decompress");
      const guard = vi.fn(() => true);
      try {
        const committed = await persistSessionTranscriptTurn(scope, {
          expectedSessionId: scope.sessionId,
          updateMode: "none",
          touchSessionEntry: true,
          messages: [
            {
              message: {
                role: "assistant",
                content: "completed",
                timestamp: 2,
                idempotencyKey: "fresh-reply",
              },
              ...(guardKind === "authority"
                ? { shouldAppendInTransaction: guard }
                : { idempotencyLookup: "scan-assistant" as const }),
            },
          ],
        });
        expect(committed.appendedCount).toBe(1);
        expect(guard).toHaveBeenCalledTimes(guardKind === "authority" ? 1 : 0);
        expect(decode).not.toHaveBeenCalled();
      } finally {
        decode.mockRestore();
      }
    });
  },
);
