import path from "node:path";
import { afterAll, assert, beforeEach, describe, expect, it } from "vitest";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import { runPreparedChannelTurn } from "../channels/turn/execution.js";
import {
  loadTranscriptEventsSync,
  loadSessionEntry,
  replaceTranscriptEventsSync,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import {
  runWithSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "../config/sessions/session-transcript-read-fence.js";
import { waitForSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  appendSessionTranscriptMessageByIdentity,
  readLatestAssistantTextByIdentity,
  readSessionTranscriptEvents,
  readSessionTranscriptRawDelta,
  readVisibleSessionTranscriptMessageEntries,
  type SessionTranscriptReadParams,
} from "./session-transcript-runtime.js";

const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-sdk-transcript-fence-");
describe("session transcript runtime read fence", () => {
  let scope: SessionTranscriptReadParams & { agentId: string; storePath: string };
  beforeEach(async () => {
    scope = {
      agentId: "main",
      sessionId: "fenced",
      sessionKey: "agent:main:fenced",
      storePath: path.join(tempDirs.make(), "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  });
  async function seedHistory() {
    const rows = [];
    for (const [index, content] of ["prompt", "prior", "prompt", "current"].entries()) {
      const now = (index + 1) * 1_000;
      const row = await appendSessionTranscriptMessageByIdentity({
        ...scope,
        message: { role: index % 2 ? "assistant" : "user", content, timestamp: now },
        now,
      });
      assert(row?.anchor);
      rows.push(row);
    }
    const [priorUser, priorAssistant, admitted] = rows;
    assert(priorUser && priorAssistant && admitted?.anchor);
    return {
      priorUser,
      priorAssistant,
      admitted,
      receipt: { ...admitted.anchor, logicalTurnId: "fenced-turn", role: "user" as const },
    };
  }

  it("fences full and raw reads before the exact admitted row and resumes from its cursor", async () => {
    const { priorUser, priorAssistant, admitted, receipt } = await seedHistory();
    const page = await runWithSessionTranscriptReadFence(receipt, async () => {
      const events = await readSessionTranscriptEvents(scope);
      expect(loadTranscriptEventsSync(scope)).toEqual(events);
      expect(events).toEqual([
        expect.objectContaining({ type: "session" }),
        expect.objectContaining({ id: priorUser.messageId }),
        expect.objectContaining({ id: priorAssistant.messageId }),
      ]);
      expect(
        (await readVisibleSessionTranscriptMessageEntries(scope)).map((entry) => entry.entryId),
      ).toEqual([priorUser.messageId, priorAssistant.messageId]);
      await expect(readLatestAssistantTextByIdentity(scope)).resolves.toMatchObject({
        id: priorAssistant.messageId,
        text: "prior",
      });
      return readSessionTranscriptRawDelta({ ...scope, maxBytes: 100_000, maxEvents: 100 });
    });
    assert(page.kind === "page");
    expect(page.hasMore).toBe(false);
    await expect(
      readSessionTranscriptRawDelta({
        ...scope,
        cursor: page.cursor,
        maxBytes: 100_000,
        maxEvents: 100,
      }),
    ).resolves.toMatchObject({
      kind: "page",
      events: [
        { event: { id: admitted.messageId, message: { content: "prompt" } } },
        { event: { message: { content: "current" } } },
      ],
      hasMore: false,
    });
  });

  it("restores cold history before channel preparation with its history boundary", async () => {
    const { receipt } = await seedHistory();
    const options = { agentId: scope.agentId, path: receipt.storePath };
    await waitForSessionTranscriptIndexReconcile(options);
    await replaceSessionEntry(scope, {
      ...loadSessionEntry(scope),
      sessionId: scope.sessionId,
      updatedAt: 1,
      lastActivityAt: 1,
      lastInteractionAt: 1,
    });
    runOpenClawAgentWriteTransaction(({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .updateTable("session_windows")
          .set({ updated_at: 1, transcript_updated_at: 1 })
          .where("session_id", "=", scope.sessionId),
      );
    }, options);
    await expect(
      runSessionColdStorageMaintenance({
        config: {
          agents: { entries: { main: {} } },
          session: {
            store: options.path,
            maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
          },
        },
      }),
    ).resolves.toMatchObject({ archivedTranscripts: 1 });
    expect(() => loadTranscriptEventsSync(scope)).toThrow(/cold storage/);
    const ctx: FinalizedMsgContext = {
      Body: "continue",
      CommandAuthorized: false,
      AgentId: scope.agentId,
      SessionKey: scope.sessionKey,
      Timestamp: 3_000,
      SessionTranscriptContext: { historyLimit: 10 },
    };
    let dispatched = false;
    await runPreparedChannelTurn({
      channel: "slack",
      routeSessionKey: scope.sessionKey,
      storePath: scope.storePath,
      ctxPayload: ctx,
      recordInboundSession: async () => undefined,
      runDispatch: async () => {
        dispatched = true;
        expect(ctx.InboundHistory?.map((entry) => entry.body)).toEqual(["prompt", "prior"]);
        return { queuedFinal: false };
      },
    });
    expect(dispatched).toBe(true);
  });

  it("rejects a read fence when any immutable admission field changes", async () => {
    const { receipt } = await seedHistory();
    const invalidReceipts = [
      { ...receipt, storePath: `${receipt.storePath}.other` },
      { ...receipt, sessionKey: `${receipt.sessionKey}:other` },
      { ...receipt, generation: `${receipt.generation}:other` },
      { ...receipt, rawSeq: receipt.rawSeq + 1 },
      { ...receipt, effectiveParentId: "other-parent" },
      { ...receipt, activeMessagePosition: receipt.activeMessagePosition + 1 },
      { ...receipt, role: "assistant" as const },
    ];
    for (const invalid of invalidReceipts) {
      expect(() =>
        runWithSessionTranscriptReadFence(invalid as unknown as typeof receipt, () =>
          loadTranscriptEventsSync(scope),
        ),
      ).toThrow(SessionTranscriptReadFenceError);
      await expect(
        runWithSessionTranscriptReadFence(invalid as unknown as typeof receipt, () =>
          readSessionTranscriptEvents(scope),
        ),
      ).rejects.toBeInstanceOf(SessionTranscriptReadFenceError);
    }
    const events = loadTranscriptEventsSync(scope);
    expect(replaceTranscriptEventsSync(scope, events)).toBe(true);
    expect(() =>
      runWithSessionTranscriptReadFence(receipt, () => loadTranscriptEventsSync(scope)),
    ).toThrow(SessionTranscriptReadFenceError);
    expect(loadTranscriptEventsSync(scope)).toEqual(events);
  });
});
