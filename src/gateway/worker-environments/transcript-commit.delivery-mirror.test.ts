import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  resolveSessionTranscriptRuntimeTarget,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "../../config/sessions/session-transcript-reconcile.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  onInternalSessionTranscriptUpdate,
  onSessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { persistInternalSourceReply } from "../internal-source-reply-persistence.js";
import {
  createWorkerTranscriptCommitStore,
  type WorkerTranscriptCommitStore,
} from "./transcript-commit-ledger.js";
import { createWorkerTranscriptCommitter } from "./transcript-commit.js";
import {
  createInterruptedCommitter,
  createRequest,
  createTranscriptCommitIdentity,
  createTurnMessages,
  RUN_EPOCH,
  SESSION_ID,
} from "./transcript-commit.test-support.js";

type WorkerTranscriptCommitter = ReturnType<typeof createWorkerTranscriptCommitter>;
const SESSION_KEY = "agent:main:worker-transcript";
const IDENTITY = createTranscriptCommitIdentity(SESSION_ID, RUN_EPOCH);

describe("worker transcript delivery mirrors", () => {
  let root: string;
  let sessionsDir: string;
  let stateDatabasePath: string;
  let storePath: string;
  let sessionTarget: Awaited<ReturnType<typeof resolveSessionTranscriptRuntimeTarget>>;
  let ADMITTED_OWNER: Omit<Parameters<WorkerTranscriptCommitter["commit"]>[0], "request">;
  let cfg: OpenClawConfig;
  let committer: WorkerTranscriptCommitter;
  let ledgerStore: WorkerTranscriptCommitStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-turn-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    sessionsDir = path.join(root, "agents", "main", "sessions");
    storePath = path.join(sessionsDir, "sessions.json");
    cfg = {
      agents: { entries: { main: {} } },
      session: {
        mainKey: "main",
        store: path.join(root, "agents", "{agentId}", "sessions", "sessions.json"),
      },
    };
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: SESSION_KEY, storePath },
      {
        lifecycleRevision: "worker-original-revision",
        sessionId: SESSION_ID,
        updatedAt: 10,
      },
    );
    sessionTarget = await resolveSessionTranscriptRuntimeTarget({
      agentId: "main",
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      storePath,
    });
    ADMITTED_OWNER = {
      identity: IDENTITY,
      sessionTarget: { ...sessionTarget, expectedLifecycleRevision: "worker-original-revision" },
      assertCurrent: () => undefined,
    };
    const database = openOpenClawStateDatabase();
    stateDatabasePath = database.path;
    ledgerStore = createWorkerTranscriptCommitStore({ database });
    committer = createWorkerTranscriptCommitter({
      getConfig: () => cfg,
      store: ledgerStore,
    });
  });

  afterEach(async () => {
    try {
      await waitForSessionTranscriptIndexReconcilesInStateDir(root);
      await closeOpenClawAgentDatabasesAsync(root);
      await closeOpenClawStateDatabaseByPathAsync(stateDatabasePath);
      await fs.rm(root, { recursive: true, force: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["base", "later user"] as const)(
    "recovers a lost mirror-backed batch receipt without changing the winning branch (%s)",
    async (winner) => {
      const [user, assistant, toolResult] = createTurnMessages();
      if (!user || assistant?.role !== "assistant" || toolResult?.role !== "toolResult") {
        throw new Error("Expected a complete worker tool turn");
      }
      const first = await committer.commit({
        ...ADMITTED_OWNER,
        request: createRequest({ messages: [user, assistant] }),
      });
      if (!first.ok) {
        throw new Error("Expected the worker tool call to commit");
      }
      await persistInternalSourceReply({
        cfg,
        sessionKey: SESSION_KEY,
        expectedSessionId: SESSION_ID,
        agentId: "main",
        runId: expectDefined(IDENTITY.runId, "worker run ID"),
        idempotencyKey: "source-reply-before-interrupted-result",
        payload: { text: "Delivered source reply" },
      });
      const request = createRequest({
        seq: 2,
        baseLeafId: first.result.newLeafId,
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
        targetId: first.result.newLeafId,
        appendParentId: first.result.newLeafId,
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
        const replay = await committer.commit({ ...ADMITTED_OWNER, request });
        expect(replay).toEqual({
          ok: true,
          result: { entryIds: committedEntryIds, newLeafId: committedEntryIds.at(-1) },
        });
        const reopened = await SessionManager.openAsync(sessionTarget);
        expect(reopened.getEntries()).toEqual(entriesBeforeReplay);
        expect(reopened.getBranch().map((entry) => entry.id)).toEqual(branchBeforeReplay);
        expect(publicUpdates).toEqual([]);
        expect(internalUpdates).toEqual([]);
        await expect(committer.commit({ ...ADMITTED_OWNER, request })).resolves.toEqual(replay);
      } finally {
        offPublic();
        offInternal();
      }
    },
  );

  it.each(["same-run mirror", "different-run mirror", "later user", "later assistant"] as const)(
    "continues a message-tool turn only across its own delivery bookkeeping (%s)",
    async (scenario) => {
      const [user, assistant, toolResult] = createTurnMessages();
      if (!user || assistant?.role !== "assistant" || toolResult?.role !== "toolResult") {
        throw new Error("Expected a complete worker tool turn");
      }
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
      const first = await committer.commit({
        ...ADMITTED_OWNER,
        request: createRequest({ messages: [user, assistant] }),
      });
      if (!first.ok) {
        throw new Error("Expected the worker tool call to commit");
      }
      const mirror = (idempotencyKey: string) =>
        persistInternalSourceReply({
          cfg,
          sessionKey: SESSION_KEY,
          expectedSessionId: SESSION_ID,
          agentId: "main",
          runId: scenario === "different-run mirror" ? "another-run" : runId,
          idempotencyKey,
          payload: { text: "Delivered source reply" },
        });
      // The real message-tool persistence owner commits before returning its result to the worker.
      await mirror("source-reply-before-result");
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
        baseLeafId: first.result.newLeafId,
        messages: [toolResult],
      });
      if (scenario !== "same-run mirror") {
        expect(await committer.commit({ ...ADMITTED_OWNER, request })).toEqual({
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
      await mirror("source-reply-after-result");
      const recovered = await committer.commit({ ...ADMITTED_OWNER, request });
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
