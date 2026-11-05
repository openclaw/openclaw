import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  onInternalSessionTranscriptUpdate,
  onSessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { persistInternalSourceReply } from "../internal-source-reply-persistence.js";
import {
  createTranscriptCommitFixture,
  expectedCommitReceipt,
  requireSuccess,
  IDENTITY,
  SESSION_KEY,
} from "./transcript-commit.fixture.test-support.js";
import { createRequest, createTurnMessages, SESSION_ID } from "./transcript-commit.test-support.js";

describe("worker transcript delivery mirrors", () => {
  let fixture: Awaited<ReturnType<typeof createTranscriptCommitFixture>>;
  let cfg: OpenClawConfig;

  const commit = (request: ReturnType<typeof createRequest>) =>
    fixture.committer.commit({ ...fixture.owner, request });
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
  const startTurn = () => {
    const [user, assistant, toolResult] = createTurnMessages();
    if (!user || assistant?.role !== "assistant" || toolResult?.role !== "toolResult") {
      throw new Error("Expected a complete worker tool turn");
    }
    return { user, assistant, toolResult };
  };
  const finalMessage = (assistant: ReturnType<typeof startTurn>["assistant"], text = "Done") => ({
    ...assistant,
    stopReason: "stop" as const,
    content: [{ type: "text" as const, text }],
  });
  const commitStart = async (messages: ReturnType<typeof createTurnMessages>) =>
    requireSuccess(await commit(createRequest({ messages }))).result.newLeafId;

  let close: Awaited<ReturnType<typeof createTranscriptCommitFixture>>["close"] | undefined;

  beforeEach(async () => {
    close = undefined;
    fixture = await createTranscriptCommitFixture(() => cfg);
    cfg = fixture.cfg;
    close = fixture.close;
  });

  afterEach(async () => {
    await close?.();
  });

  it.each(["base", "later user"] as const)(
    "recovers a lost mirror-backed batch receipt without changing the winning branch (%s)",
    async (winner) => {
      const { user, assistant, toolResult } = startTurn();
      const baseLeafId = await commitStart([user, assistant]);
      await mirror("source-reply-before-interrupted-result");
      const request = createRequest({
        seq: 2,
        baseLeafId,
        messages: [toolResult, { ...finalMessage(assistant), itemId: "abandoned-final" }],
      });
      await fixture.interrupt(request, "lost batch receipt");
      const manager = await SessionManager.openAsync(fixture.sessionTarget);
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
        (await SessionManager.openAsync(fixture.sessionTarget))
          .getBranch()
          .map((entry) => entry.id),
      ).toEqual(branchBeforeReplay);
      const publicUpdates: unknown[] = [];
      const internalUpdates: unknown[] = [];
      const offPublic = onSessionTranscriptUpdate((update) => publicUpdates.push(update));
      const offInternal = onInternalSessionTranscriptUpdate((update) =>
        internalUpdates.push(update),
      );
      try {
        const replay = await commit(request);
        expect(replay).toEqual(expectedCommitReceipt(committedEntryIds));
        const reopened = await SessionManager.openAsync(fixture.sessionTarget);
        expect(reopened.getEntries()).toEqual(entriesBeforeReplay);
        expect(reopened.getBranch().map((entry) => entry.id)).toEqual(branchBeforeReplay);
        expect([publicUpdates, internalUpdates]).toEqual([[], []]);
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
      const { user, assistant, toolResult } = startTurn();
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
        const manager = await SessionManager.openAsync(fixture.sessionTarget);
        await manager.appendMessageAsync(
          scenario === "later user"
            ? { role: "user", content: "A different input", timestamp: 400 }
            : finalMessage(assistant, "Other output"),
        );
      }
      const request = createRequest({ seq: 2, baseLeafId, messages: [toolResult] });
      if (scenario !== "same-run mirror") {
        expect(await commit(request)).toEqual({ ok: false, reason: "stale-base-leaf" });
        return;
      }

      await fixture.interrupt(request, "lost result receipt");
      // Delivery bookkeeping can also follow the committed result before its ACK is recovered.
      await mirrorForRun("source-reply-after-result");
      const recovered = requireSuccess(await commit(request));
      expect(recovered.result.entryIds).toHaveLength(1);
      const final = await commit(
        createRequest({
          seq: 3,
          baseLeafId: recovered.result.newLeafId,
          messages: [finalMessage(assistant)],
        }),
      );
      expect(final.ok).toBe(true);
      const manager = await SessionManager.openAsync(fixture.sessionTarget);
      expect(
        manager
          .getBranch()
          .flatMap((entry) => (entry.type === "message" ? [entry.message.role] : [])),
      ).toEqual(["user", "assistant", "assistant", "toolResult", "assistant", "assistant"]);
    },
  );
});
