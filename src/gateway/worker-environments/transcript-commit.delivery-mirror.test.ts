import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import type { resolveSessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  onInternalSessionTranscriptUpdate,
  onSessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { persistInternalSourceReply } from "../internal-source-reply-persistence.js";
import type { WorkerTranscriptCommitStore } from "./transcript-commit-ledger.js";
import {
  createTranscriptCommitFixture,
  IDENTITY,
  SESSION_KEY,
} from "./transcript-commit.fixture.test-support.js";
import type { createWorkerTranscriptCommitter } from "./transcript-commit.js";
import {
  createInterruptedCommitter,
  createRequest,
  createTurnMessages,
  SESSION_ID,
} from "./transcript-commit.test-support.js";

type WorkerTranscriptCommitter = ReturnType<typeof createWorkerTranscriptCommitter>;

describe("worker transcript delivery mirrors", () => {
  let sessionTarget: Awaited<ReturnType<typeof resolveSessionTranscriptRuntimeTarget>>;
  let ADMITTED_OWNER: Omit<Parameters<WorkerTranscriptCommitter["commit"]>[0], "request">;
  let cfg: OpenClawConfig;
  let committer: WorkerTranscriptCommitter;
  let ledgerStore: WorkerTranscriptCommitStore;

  const commit = (request: ReturnType<typeof createRequest>) =>
    committer.commit({ ...ADMITTED_OWNER, request });
  const mirror = (idempotencyKey: string, runId = expectDefined(IDENTITY.runId, "worker run ID")) =>
    persistInternalSourceReply({
      cfg,
      sessionKey: SESSION_KEY,
      expectedSessionId: SESSION_ID,
      agentId: "main",
      runId,
      idempotencyKey,
      payload: { text: "Delivered source reply" },
    });
  const startTurn = async () => {
    const [user, assistant, toolResult] = createTurnMessages();
    if (!user || assistant?.role !== "assistant" || toolResult?.role !== "toolResult") {
      throw new Error("Expected a complete worker tool turn");
    }
    return { user, assistant, toolResult };
  };
  const commitStart = async (messages: ReturnType<typeof createTurnMessages>) => {
    const first = await commit(createRequest({ messages }));
    if (!first.ok) {
      throw new Error("Expected the worker tool call to commit");
    }
    return first.result.newLeafId;
  };

  let close: Awaited<ReturnType<typeof createTranscriptCommitFixture>>["close"] | undefined;

  beforeEach(async () => {
    close = undefined;
    ({
      cfg,
      sessionTarget,
      owner: ADMITTED_OWNER,
      ledgerStore,
      committer,
      close,
    } = await createTranscriptCommitFixture(() => cfg));
  });

  afterEach(async () => {
    await close?.();
  });

  it.each(["base", "later user"] as const)(
    "recovers a lost mirror-backed batch receipt without changing the winning branch (%s)",
    async (winner) => {
      const { user, assistant, toolResult } = await startTurn();
      const baseLeafId = await commitStart([user, assistant]);
      await mirror("source-reply-before-interrupted-result");
      const request = createRequest({
        seq: 2,
        baseLeafId,
        messages: [
          toolResult,
          {
            ...assistant,
            itemId: "abandoned-final",
            stopReason: "stop",
            content: [{ type: "text", text: "Done" }],
          },
        ],
      });
      const interrupted = createInterruptedCommitter(() => cfg, ledgerStore, "lost batch receipt");
      await expect(interrupted.commit({ ...ADMITTED_OWNER, request })).rejects.toThrow(
        "lost batch receipt",
      );
      const manager = await SessionManager.openAsync(sessionTarget);
      const committedEntryIds = manager
        .getBranch()
        .slice(-2)
        .map((entry) => entry.id);
      expect(committedEntryIds).toHaveLength(2);
      // branchAsync only selects this manager's next append; recovery reads durable navigation.
      await manager.appendLeafControlAsync({
        targetId: baseLeafId,
        appendParentId: baseLeafId,
      });
      if (winner === "later user") {
        await manager.appendMessageAsync({
          role: "user",
          content: "A different input",
          timestamp: 400,
        });
      }
      const entriesBeforeReplay = structuredClone(manager.getEntries());
      const branchBeforeReplay = manager.getBranch().map((entry) => entry.id);
      expect(
        (await SessionManager.openAsync(sessionTarget)).getBranch().map((entry) => entry.id),
      ).toEqual(branchBeforeReplay);
      const publicUpdates: unknown[] = [];
      const internalUpdates: unknown[] = [];
      const offPublic = onSessionTranscriptUpdate((update) => publicUpdates.push(update));
      const offInternal = onInternalSessionTranscriptUpdate((update) =>
        internalUpdates.push(update),
      );
      try {
        const replay = await commit(request);
        expect(replay).toEqual({
          ok: true,
          result: { entryIds: committedEntryIds, newLeafId: committedEntryIds.at(-1) },
        });
        const reopened = await SessionManager.openAsync(sessionTarget);
        expect(reopened.getEntries()).toEqual(entriesBeforeReplay);
        expect(reopened.getBranch().map((entry) => entry.id)).toEqual(branchBeforeReplay);
        expect(publicUpdates).toEqual([]);
        expect(internalUpdates).toEqual([]);
        await expect(commit(request)).resolves.toEqual(replay);
      } finally {
        offPublic();
        offInternal();
      }
    },
  );

  it.each(["same-run mirror", "different-run mirror", "later user", "later assistant"] as const)(
    "continues a message-tool turn only across its own delivery bookkeeping (%s)",
    async (scenario) => {
      const { user, assistant, toolResult } = await startTurn();
      const runId = expectDefined(IDENTITY.runId, "worker run ID");
      assistant.content = [
        {
          type: "toolCall",
          id: "call-message-1",
          name: "message",
          arguments: { action: "send", message: "Delivered source reply" },
        },
      ];
      toolResult.toolCallId = "call-message-1";
      toolResult.toolName = "message";
      const baseLeafId = await commitStart([user, assistant]);
      const mirrorForRun = (key: string) =>
        mirror(key, scenario === "different-run mirror" ? "another-run" : runId);
      // The real message-tool persistence owner commits before returning its result to the worker.
      await mirrorForRun("source-reply-before-result");
      if (scenario === "later user" || scenario === "later assistant") {
        const manager = await SessionManager.openAsync(sessionTarget);
        await manager.appendMessageAsync(
          scenario === "later user"
            ? { role: "user", content: "A different input", timestamp: 400 }
            : {
                ...assistant,
                stopReason: "stop",
                content: [{ type: "text", text: "Other output" }],
              },
        );
      }
      const request = createRequest({
        seq: 2,
        baseLeafId,
        messages: [toolResult],
      });
      if (scenario !== "same-run mirror") {
        expect(await commit(request)).toEqual({
          ok: false,
          reason: "stale-base-leaf",
        });
        return;
      }

      const interrupted = createInterruptedCommitter(() => cfg, ledgerStore, "lost result receipt");
      await expect(interrupted.commit({ ...ADMITTED_OWNER, request })).rejects.toThrow(
        "lost result receipt",
      );
      // Delivery bookkeeping can also follow the committed result before its ACK is recovered.
      await mirrorForRun("source-reply-after-result");
      const recovered = await commit(request);
      if (!recovered.ok) {
        throw new Error("Expected the committed tool result receipt to recover");
      }
      expect(recovered.result.entryIds).toHaveLength(1);
      const final = await committer.commit({
        ...ADMITTED_OWNER,
        request: createRequest({
          seq: 3,
          baseLeafId: recovered.result.newLeafId,
          messages: [
            { ...assistant, stopReason: "stop", content: [{ type: "text", text: "Done" }] },
          ],
        }),
      });
      expect(final.ok).toBe(true);
      const manager = await SessionManager.openAsync(sessionTarget);
      expect(
        manager
          .getBranch()
          .flatMap((entry) => (entry.type === "message" ? [entry.message.role] : [])),
      ).toEqual(["user", "assistant", "assistant", "toolResult", "assistant", "assistant"]);
    },
  );
});
