import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { reconcileSessionTranscriptIndexInTransaction } from "../config/sessions/session-transcript-index.js";
import { runWithSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { readSessionTranscriptReplayGroups } from "./context-engine-transcript-runtime.js";
import {
  appendSessionTranscriptMessageByIdentity,
  withSessionTranscriptWriteLock,
} from "./session-transcript-runtime.js";

const dirs = useSessionStoreTempDirs(afterAll, "openclaw-sdk-replay-");

/** Persist through the real writer so SDK reads exercise worker selection and admission. */
async function fixture(name: string) {
  const scope = {
    agentId: "main",
    sessionId: name,
    sessionKey: `agent:main:${name}`,
    storePath: path.join(dirs.make(), "sessions.sqlite"),
  };
  await upsertSessionEntryCore(scope, { sessionId: name, updatedAt: 1 });
  return scope;
}

describe("canonical transcript replay groups", () => {
  it("preserves canonical metadata and ordered custom carriers outside the live tail, off-thread", async () => {
    const scope = await fixture("canonical");
    const message = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Subagent Context" }],
      timestamp: 1000,
      provenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:child",
        sourceChannel: "internal",
        sourceTool: "subagent_settle",
      },
      inputProvenance: { kind: "inter_session" },
      __openclaw: {
        modelPromptProjection: { content: "recorded input" },
        media: [{ path: "/synthetic/attachment.png" }],
      },
    };
    const user = await appendSessionTranscriptMessageByIdentity({ ...scope, message, now: 1000 });
    expect(user).toBeDefined();
    const carriers = [
      {
        id: "runtime",
        customType: "openclaw.runtime-context",
        content: "runtime facts",
        details: { source: "openclaw-runtime-context", runtimeContextCarrier: true },
      },
      {
        id: "system",
        customType: "openclaw.system-update",
        content: "operator facts",
        details: { kind: "runtime-context" },
      },
    ];
    let parentId = user!.messageId;
    const metadata = [
      { type: "thinking_level_change", thinkingLevel: "high" },
      { type: "model_change", provider: "synthetic", modelId: "fixture" },
      { type: "custom", customType: "model-snapshot", data: { padding: "x".repeat(20_000) } },
      { type: "label", targetId: user!.messageId, label: "retained" },
      { type: "session_info", name: "Canonical replay" },
    ] as const;
    for (const [index, entry] of metadata.entries()) {
      const id = `metadata-${index}`;
      await appendTranscriptEvent(scope, {
        ...entry,
        id,
        parentId,
        timestamp: new Date(1500).toISOString(),
      });
      parentId = id;
    }
    for (const carrier of carriers) {
      await appendTranscriptEvent(scope, {
        type: "custom_message",
        ...carrier,
        parentId,
        display: false,
        timestamp: new Date(2000).toISOString(),
      });
      parentId = carrier.id;
    }
    // A large unrelated tail must not consume the point-selected replay budget.
    await appendSessionTranscriptMessageByIdentity({
      ...scope,
      parentId,
      message: { role: "assistant", content: "x".repeat(100_000) },
    });
    await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "user", content: "foreground" },
    });
    const observation = observeHostDataSql();
    try {
      await expect(
        readSessionTranscriptReplayGroups({
          ...scope,
          entryIds: [user!.messageId],
          maxBytes: 5000,
        }),
      ).resolves.toEqual([
        {
          entryId: user!.messageId,
          message,
          carriers: carriers.map((carrier) => ({
            customType: carrier.customType,
            content: carrier.content,
            details: carrier.details,
            role: "custom",
            display: false,
            timestamp: 2000,
          })),
        },
      ]);
      expect(observation.queries).toEqual([]);
    } finally {
      observation.restore();
    }
    // The inherited write-lock path must use its prepared worker, not reacquire the lock.
    await withSessionTranscriptWriteLock(scope, async () => {
      await expect(
        readSessionTranscriptReplayGroups({ ...scope, entryIds: [user!.messageId] }),
      ).resolves.toHaveLength(1);
    });
  });

  it.each(["message", "custom"])(
    "stops at %s model boundaries and omits inactive, duplicate, and non-user IDs",
    async (boundaryType) => {
      const scope = await fixture("branch");
      const root = await appendSessionTranscriptMessageByIdentity({
        ...scope,
        message: { role: "user", content: "root" },
      });
      const abandoned = await appendSessionTranscriptMessageByIdentity({
        ...scope,
        message: { role: "user", content: "abandoned" },
      });
      await appendTranscriptEvent(scope, {
        type: "custom_message",
        id: "abandoned-carrier",
        parentId: abandoned!.messageId,
        customType: "openclaw.runtime-context",
        content: "wrong branch",
        display: false,
        timestamp: new Date(1000).toISOString(),
      });
      await appendTranscriptMessage(scope, {
        eventId: "pending",
        parentId: root!.messageId,
        message: {
          role: "assistant",
          provider: "openclaw",
          model: "automation-result",
          content: "Background result",
          excludeFromContext: true,
          openclawModelPlacement: "pending",
        },
      });
      const branch = { messageId: "selected-user" };
      await appendTranscriptMessage(scope, {
        eventId: branch.messageId,
        parentId: "pending",
        message: { role: "user", content: "selected" },
      });
      const assistant = { messageId: "selected-assistant" };
      if (boundaryType === "message") {
        await appendTranscriptMessage(scope, {
          eventId: assistant.messageId,
          parentId: branch.messageId,
          message: { role: "assistant", content: "answer" },
        });
      } else {
        await appendTranscriptEvent(scope, {
          type: "custom",
          id: assistant.messageId,
          parentId: branch.messageId,
          customType: "openclaw.background-result-placement",
          data: { afterEntryId: branch.messageId, resultEntryIds: ["pending"] },
          timestamp: new Date(1000).toISOString(),
        });
      }
      await appendTranscriptEvent(scope, {
        type: "custom_message",
        id: "after-assistant",
        parentId: assistant!.messageId,
        customType: "openclaw.runtime-context",
        content: "not attached to user",
        display: false,
        timestamp: new Date(1000).toISOString(),
      });
      const databaseOptions = toDatabaseOptions(resolveSqliteTranscriptReadScope(scope));
      // Establish the branch fixture through the native projection writer; the SDK read stays off-thread.
      runOpenClawAgentWriteTransaction(
        (database) => reconcileSessionTranscriptIndexInTransaction(database.db, scope.sessionId),
        databaseOptions,
      );
      const result = await readSessionTranscriptReplayGroups({
        ...scope,
        entryIds: [
          branch!.messageId,
          root!.messageId,
          abandoned!.messageId,
          assistant!.messageId,
          "missing",
          branch!.messageId,
        ],
      });
      expect(result.map(({ entryId, carriers }) => ({ entryId, carriers }))).toEqual([
        { entryId: branch!.messageId, carriers: [] },
        { entryId: root!.messageId, carriers: [] },
      ]);
    },
  );

  it("fences users and carriers before the admitted row and rejects a stale receipt", async () => {
    const scope = await fixture("fence");
    const prior = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "user", content: "prior" },
    });
    await appendTranscriptEvent(scope, {
      type: "custom_message",
      id: "before-fence",
      parentId: prior!.messageId,
      customType: "openclaw.runtime-context",
      content: "prior facts",
      display: false,
      timestamp: new Date(1000).toISOString(),
    });
    const admitted = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "user", content: "current" },
    });
    await appendTranscriptEvent(scope, {
      type: "custom_message",
      id: "after-fence",
      parentId: admitted!.messageId,
      customType: "openclaw.runtime-context",
      content: "current facts",
      display: false,
      timestamp: new Date(2000).toISOString(),
    });
    if (!admitted?.anchor) {
      throw new Error("Expected a real admitted anchor");
    }
    const receipt = { ...admitted.anchor, logicalTurnId: "fence", role: "user" as const };
    const read = () =>
      readSessionTranscriptReplayGroups({
        ...scope,
        entryIds: [prior!.messageId, admitted.messageId],
      });
    const result = await runWithSessionTranscriptReadFence(receipt, read);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      entryId: prior!.messageId,
      carriers: [{ role: "custom", content: "prior facts" }],
    });
    await expect(
      runWithSessionTranscriptReadFence({ ...receipt, generation: "stale" }, read),
    ).rejects.toThrow("admission generation changed");
  });

  it("rejects the entire selection when any user or carrier exceeds the cumulative source-byte budget", async () => {
    const scope = await fixture("bounds");
    const small = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "user", content: "small" },
    });
    const large = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "user", content: "x".repeat(10_000) },
    });
    await expect(
      readSessionTranscriptReplayGroups({
        ...scope,
        entryIds: [small!.messageId, large!.messageId],
        maxBytes: 2000,
      }),
    ).rejects.toThrow("exceeds maxBytes");
    await appendTranscriptEvent(scope, {
      type: "custom_message",
      id: "large-carrier",
      parentId: large!.messageId,
      customType: "openclaw.runtime-context",
      content: "x".repeat(20_000),
      display: false,
      timestamp: new Date(1000).toISOString(),
    });
    await expect(
      readSessionTranscriptReplayGroups({
        ...scope,
        entryIds: [large!.messageId],
        maxBytes: 15_000,
      }),
    ).rejects.toThrow("exceeds maxBytes");
    await expect(
      readSessionTranscriptReplayGroups({ ...scope, entryIds: [small!.messageId], maxBytes: 2000 }),
    ).resolves.toHaveLength(1);
    await expect(
      readSessionTranscriptReplayGroups({ ...scope, entryIds: [], maxBytes: 0 }),
    ).rejects.toThrow(RangeError);
  });
});
