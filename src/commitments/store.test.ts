import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drainFileLockStateForTest, resetFileLockStateForTest } from "../infra/file-lock.js";
import {
  listCommitments,
  listDueCommitmentsForSession,
  loadCommitmentStore,
  markCommitmentsAttempted,
  markCommitmentsStatus,
  saveCommitmentStore,
  upsertInferredCommitments,
} from "./store.js";
import type { CommitmentRecord } from "./types.js";

describe("commitment store delivery selection", () => {
  const tmpDirs: string[] = [];
  const nowMs = Date.parse("2026-04-29T17:00:00.000Z");
  const sessionKey = "agent:main:telegram:user-155462274";

  afterEach(async () => {
    vi.unstubAllEnvs();
    await drainFileLockStateForTest();
    resetFileLockStateForTest();
    await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tmpDirs.length = 0;
  });

  async function useTempStateDir(): Promise<string> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-commitments-store-"));
    tmpDirs.push(tmpDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
    return tmpDir;
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
    const tmpDir = await useTempStateDir();
    const storePath = path.join(tmpDir, "commitments", "commitments.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          commitments: [commitment()],
        },
        null,
        2,
      ),
      "utf8",
    );

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
    const raw = await fs.readFile(storePath, "utf8");
    expect(raw).not.toContain("I have an interview tomorrow.");
    expect(raw).not.toContain("sourceUserText");
    expect(raw).not.toContain("sourceAssistantText");
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

  it("preserves disjoint status updates from concurrent writers", async () => {
    await useTempStateDir();
    await saveCommitmentStore(undefined, {
      version: 1,
      commitments: [
        commitment({ id: "cm_race_a", dedupeKey: "race:a" }),
        commitment({ id: "cm_race_b", dedupeKey: "race:b" }),
      ],
    });

    await Promise.all([
      markCommitmentsStatus({
        ids: ["cm_race_a"],
        status: "dismissed",
        nowMs: nowMs + 1,
      }),
      markCommitmentsStatus({
        ids: ["cm_race_b"],
        status: "dismissed",
        nowMs: nowMs + 2,
      }),
    ]);

    const store = await loadCommitmentStore();
    const byId = new Map(store.commitments.map((entry) => [entry.id, entry]));
    expect(byId.get("cm_race_a")?.status).toBe("dismissed");
    expect(byId.get("cm_race_a")?.dismissedAtMs).toBe(nowMs + 1);
    expect(byId.get("cm_race_b")?.status).toBe("dismissed");
    expect(byId.get("cm_race_b")?.dismissedAtMs).toBe(nowMs + 2);
  });

  it("preserves concurrent attempt and sent-status updates", async () => {
    await useTempStateDir();
    await saveCommitmentStore(undefined, {
      version: 1,
      commitments: [
        commitment({ id: "cm_attempted", dedupeKey: "race:attempted" }),
        commitment({ id: "cm_sent", dedupeKey: "race:sent" }),
      ],
    });

    await Promise.all([
      markCommitmentsAttempted({ ids: ["cm_attempted"], nowMs: nowMs + 3 }),
      markCommitmentsStatus({
        ids: ["cm_sent"],
        status: "sent",
        nowMs: nowMs + 4,
      }),
    ]);

    const store = await loadCommitmentStore();
    const byId = new Map(store.commitments.map((entry) => [entry.id, entry]));
    expect(byId.get("cm_attempted")?.attempts).toBe(1);
    expect(byId.get("cm_attempted")?.lastAttemptAtMs).toBe(nowMs + 3);
    expect(byId.get("cm_sent")?.status).toBe("sent");
    expect(byId.get("cm_sent")?.sentAtMs).toBe(nowMs + 4);
  });

  it("preserves inferred upserts when another writer changes status", async () => {
    await useTempStateDir();
    await saveCommitmentStore(undefined, {
      version: 1,
      commitments: [commitment({ id: "cm_existing", dedupeKey: "race:existing" })],
    });

    const [created] = await Promise.all([
      upsertInferredCommitments({
        item: {
          itemId: "turn-upserted",
          agentId: "main",
          sessionKey,
          channel: "telegram",
          to: "155462274",
          nowMs,
          timezone: "America/Los_Angeles",
          userText: "I have a project demo tomorrow.",
          existingPending: [],
        },
        candidates: [
          {
            candidate: {
              itemId: "turn-upserted",
              kind: "event_check_in",
              sensitivity: "routine",
              source: "inferred_user_context",
              reason: "The user mentioned a project demo.",
              suggestedText: "How did the project demo go?",
              dedupeKey: "race:upserted",
              confidence: 0.91,
              dueWindow: {
                earliest: "2026-04-30T17:01:00.000Z",
                latest: "2026-04-30T17:02:00.000Z",
                timezone: "America/Los_Angeles",
              },
            },
            earliestMs: nowMs + 60_000,
            latestMs: nowMs + 120_000,
            timezone: "America/Los_Angeles",
          },
        ],
        nowMs: nowMs + 5,
      }),
      markCommitmentsStatus({
        ids: ["cm_existing"],
        status: "dismissed",
        nowMs: nowMs + 6,
      }),
    ]);

    expect(created).toHaveLength(1);
    const store = await loadCommitmentStore();
    const byDedupe = new Map(store.commitments.map((entry) => [entry.dedupeKey, entry]));
    expect(byDedupe.get("race:existing")?.status).toBe("dismissed");
    expect(byDedupe.get("race:existing")?.dismissedAtMs).toBe(nowMs + 6);
    expect(byDedupe.get("race:upserted")?.status).toBe("pending");
    expect(byDedupe.get("race:upserted")?.suggestedText).toBe("How did the project demo go?");
  });
});
