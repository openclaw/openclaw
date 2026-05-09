import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { writeOpenClawStateKvJson } from "../state/openclaw-state-kv.js";
import {
  listCommitments,
  listDueCommitmentsForSession,
  loadCommitmentStore,
  saveCommitmentStore,
} from "./store.js";
import type { CommitmentRecord } from "./types.js";

describe("commitment store delivery selection", () => {
  const tmpDirs: string[] = [];
  const nowMs = Date.parse("2026-04-29T17:00:00.000Z");
  const sessionKey = "agent:main:telegram:user-155462274";

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tmpDirs.length = 0;
  });

  async function useTempStateDir(): Promise<string> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-commitments-store-"));
    tmpDirs.push(tmpDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
    return tmpDir;
  }

  function readCommitmentRecordJson(id: string): string {
    const stateDatabase = openOpenClawStateDatabase();
    const db = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "commitments">>(
      stateDatabase.db,
    );
    return (
      executeSqliteQueryTakeFirstSync(
        stateDatabase.db,
        db.selectFrom("commitments").select("record_json").where("id", "=", id),
      )?.record_json ?? ""
    );
  }

  function corruptCommitmentRecordJson(id: string): void {
    const stateDatabase = openOpenClawStateDatabase();
    const db = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "commitments">>(
      stateDatabase.db,
    );
    executeSqliteQuerySync(
      stateDatabase.db,
      db
        .updateTable("commitments")
        .set({ record_json: '{"id":"wrong","status":"dismissed"}' })
        .where("id", "=", id),
    );
  }

  function commitment(overrides?: Partial<CommitmentRecord>): CommitmentRecord {
    return {
      id: "cm_interview",
      agentId: "main",
      sessionKey,
      channel: "telegram",
      to: "155462274",
      kind: "event_check_in",
      sensitivity: "routine",
      source: "inferred_user_context",
      status: "pending",
      reason: "The user said they had an interview yesterday.",
      suggestedText: "How did the interview go?",
      dedupeKey: "interview:2026-04-28",
      confidence: 0.92,
      dueWindow: {
        earliestMs: nowMs - 60_000,
        latestMs: nowMs + 60 * 60_000,
        timezone: "America/Los_Angeles",
      },
      sourceUserText: "I have an interview tomorrow.",
      createdAtMs: nowMs - 24 * 60 * 60_000,
      updatedAtMs: nowMs - 24 * 60 * 60_000,
      attempts: 0,
      ...overrides,
    };
  }

  it("does not surface due commitments unless inferred commitments are enabled", async () => {
    await useTempStateDir();
    await saveCommitmentStore(undefined, {
      version: 1,
      commitments: [commitment()],
    });

    await expect(
      listDueCommitmentsForSession({
        cfg: {},
        agentId: "main",
        sessionKey,
        nowMs,
      }),
    ).resolves.toStrictEqual([]);
  });

  it("limits delivered commitments per agent session in a rolling day", async () => {
    await useTempStateDir();
    await saveCommitmentStore(undefined, {
      version: 1,
      commitments: [
        commitment({ id: "cm_sent", status: "sent", sentAtMs: nowMs - 60_000 }),
        commitment({ id: "cm_pending", dedupeKey: "interview:followup" }),
      ],
    });

    await expect(
      listDueCommitmentsForSession({
        cfg: { commitments: { enabled: true, maxPerDay: 1 } },
        agentId: "main",
        sessionKey,
        nowMs,
      }),
    ).resolves.toStrictEqual([]);

    const store = await loadCommitmentStore();
    expect(store.commitments).toHaveLength(2);
  });

  it("expires stale pending commitments instead of leaving them hidden forever", async () => {
    await useTempStateDir();
    await saveCommitmentStore(undefined, {
      version: 1,
      commitments: [
        commitment({
          dueWindow: {
            earliestMs: nowMs - 5 * 24 * 60 * 60_000,
            latestMs: nowMs - 4 * 24 * 60 * 60_000,
            timezone: "America/Los_Angeles",
          },
        }),
      ],
    });

    await expect(
      listDueCommitmentsForSession({
        cfg: { commitments: { enabled: true } },
        agentId: "main",
        sessionKey,
        nowMs,
      }),
    ).resolves.toStrictEqual([]);

    const store = await loadCommitmentStore();
    expect(store.commitments[0]?.id).toBe("cm_interview");
    expect(store.commitments[0]?.status).toBe("expired");
    expect(store.commitments[0]?.expiredAtMs).toBe(nowMs);
    expect(store.commitments[0]?.updatedAtMs).toBe(nowMs);
  });

  it("rewrites legacy source text fields when due commitments are listed", async () => {
    await useTempStateDir();
    writeOpenClawStateKvJson("commitments", "store", {
      version: 1,
      commitments: [commitment()],
    });

    const dueCommitments = await listDueCommitmentsForSession({
      cfg: { commitments: { enabled: true } },
      agentId: "main",
      sessionKey,
      nowMs,
    });
    expect(dueCommitments).toHaveLength(1);
    expect(dueCommitments[0]?.id).toBe("cm_interview");

    const store = await loadCommitmentStore();
    expect(store.commitments[0]).not.toHaveProperty("sourceUserText");
    expect(store.commitments[0]).not.toHaveProperty("sourceAssistantText");
    const raw = readCommitmentRecordJson("cm_interview");
    expect(raw).not.toContain("I have an interview tomorrow.");
    expect(raw).not.toContain("sourceUserText");
    expect(raw).not.toContain("sourceAssistantText");
  });

  it("loads commitments from typed SQLite columns, not the debug JSON copy", async () => {
    await useTempStateDir();
    await saveCommitmentStore({
      version: 1,
      commitments: [
        commitment({
          accountId: "primary",
          to: "155462274",
          threadId: "thread-1",
          senderId: "sender-1",
          sourceMessageId: "msg-source",
          sourceRunId: "run-source",
          sentAtMs: nowMs - 60_000,
          attempts: 2,
        }),
      ],
    });
    corruptCommitmentRecordJson("cm_interview");

    const store = await loadCommitmentStore();

    expect(store.commitments).toHaveLength(1);
    expect(store.commitments[0]).toMatchObject({
      id: "cm_interview",
      agentId: "main",
      sessionKey,
      channel: "telegram",
      accountId: "primary",
      to: "155462274",
      threadId: "thread-1",
      senderId: "sender-1",
      status: "pending",
      reason: "The user said they had an interview yesterday.",
      suggestedText: "How did the interview go?",
      dedupeKey: "interview:2026-04-28",
      attempts: 2,
      sourceMessageId: "msg-source",
      sourceRunId: "run-source",
      sentAtMs: nowMs - 60_000,
    });
  });

  it("lists expired commitments after expiry transition", async () => {
    await useTempStateDir();
    await saveCommitmentStore(undefined, {
      version: 1,
      commitments: [
        commitment({
          dueWindow: {
            earliestMs: nowMs - 5 * 24 * 60 * 60_000,
            latestMs: nowMs - 4 * 24 * 60 * 60_000,
            timezone: "America/Los_Angeles",
          },
        }),
      ],
    });

    await listDueCommitmentsForSession({
      cfg: { commitments: { enabled: true } },
      agentId: "main",
      sessionKey,
      nowMs,
    });

    const expiredCommitments = await listCommitments({ status: "expired" });
    expect(expiredCommitments).toHaveLength(1);
    expect(expiredCommitments[0]?.id).toBe("cm_interview");
    expect(expiredCommitments[0]?.status).toBe("expired");
  });
});
