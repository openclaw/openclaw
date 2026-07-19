import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { readRestartSentinel, writeRestartSentinel } from "./restart-sentinel.js";
import {
  readUpdateRecoveryJournal,
  rewriteUpdateRecoveryJournal,
  UPDATE_RECOVERY_JOURNAL_ENV,
} from "./update-recovery-journal.js";
import {
  advanceUpdateTransactionMarker,
  beginUpdateTransactionReplayAdmission,
  claimExpiredUpdateTransactionOwner,
  claimUpdateTransactionRollback,
  completeUpdateTransactionReplayAdmission,
  isActiveUpdateTransactionMarker,
  isUpdateTransactionConfirmed,
  isUpdateTransactionProbationReleased,
  markUpdateTransactionDeliveryAck,
  markUpdateTransactionConfirmationFailed,
  markUpdateTransactionHumanReply,
  markUpdateTransactionProbationReleased,
  refreshUpdateTransactionOwnerLease,
  resolveUpdateTransactionStartupDisposition,
  waitForUpdateTransactionConfirmation,
  writeUpdateTransactionMarker,
} from "./update-transaction-marker.js";

const roots: string[] = [];

async function createEnv(): Promise<NodeJS.ProcessEnv> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-marker-"));
  roots.push(root);
  return { ...process.env, OPENCLAW_STATE_DIR: root, OPENCLAW_TEST_FAST: "1" };
}

async function writeMarker(env: NodeJS.ProcessEnv, tier: "delivery" | "human") {
  return await writeUpdateTransactionMarker({
    env,
    confirmationTier: tier,
    meta: {
      handoffId: "handoff-1",
      sessionKey: "agent:main:telegram:direct:chat-1",
      deliveryContext: { channel: "telegram", to: "chat-1", accountId: "default" },
    },
    result: {
      status: "ok",
      mode: "npm",
      root: "/managed/openclaw",
      before: { version: "1" },
      after: { version: "2" },
      steps: [],
      durationMs: 10,
    },
  });
}

async function markHealthy(env: NodeJS.ProcessEnv) {
  await advanceUpdateTransactionMarker({ handoffId: "handoff-1", phase: "healthy", env });
}

afterEach(async () => {
  closeOpenClawStateDatabase();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("update transaction marker", () => {
  it("blocks Gateway bootstrap when a transaction leaves active probation for rollback", async () => {
    const env = await createEnv();
    const marker = await writeMarker(env, "delivery");
    expect(resolveUpdateTransactionStartupDisposition(marker.payload)).toBe("probation");

    const rollingBack = await claimUpdateTransactionRollback({
      handoffId: "handoff-1",
      rollbackOwner: "rollback-1",
      reason: "confirmation timed out",
      env,
    });
    expect(resolveUpdateTransactionStartupDisposition(rollingBack?.payload)).toBe("blocked");

    const rolledBack = await advanceUpdateTransactionMarker({
      handoffId: "handoff-1",
      phase: "rolled-back",
      rollbackOwner: "rollback-1",
      confirmationStatus: "failed",
      status: "error",
      env,
    });
    expect(resolveUpdateTransactionStartupDisposition(rolledBack?.payload)).toBe("normal");
  });

  it("persists replay admission fences and rejects confirmation immediately after failure", async () => {
    const env = await createEnv();
    await writeMarker(env, "delivery");
    await markHealthy(env);

    await beginUpdateTransactionReplayAdmission({ handoffId: "handoff-1", env });
    await beginUpdateTransactionReplayAdmission({ handoffId: "handoff-1", env });
    expect((await readRestartSentinel(env))?.payload.stats?.updateReplayAdmissionsPending).toBe(2);
    await completeUpdateTransactionReplayAdmission({ handoffId: "handoff-1", env });
    expect((await readRestartSentinel(env))?.payload.stats?.updateReplayAdmissionsPending).toBe(1);

    await markUpdateTransactionConfirmationFailed({
      handoffId: "handoff-1",
      reason: "interrupted replay admission",
      env,
    });
    await expect(
      waitForUpdateTransactionConfirmation({
        handoffId: "handoff-1",
        rollbackOwner: "rollback-1",
        timeoutMs: 60_000,
        env,
        sleep: async () => {
          throw new Error("failed confirmation should not poll");
        },
      }),
    ).resolves.toBe(false);
  });

  it("claims rollback from the external journal when the state database is unreadable", async () => {
    const env = await createEnv();
    const journalPath = path.join(env.OPENCLAW_STATE_DIR!, "recovery-journal.json");
    env[UPDATE_RECOVERY_JOURNAL_ENV] = journalPath;
    await writeUpdateTransactionMarker({
      env,
      confirmationTier: "delivery",
      meta: { handoffId: "handoff-1" },
      phase: "restart",
      rollback: {
        packageRoot: "/managed/openclaw",
        retainedPackageRoot: "/managed/.openclaw-previous",
        stateSnapshotRoot: "/managed/.openclaw-previous-state",
        nodePath: process.execPath,
      },
      result: {
        status: "ok",
        mode: "npm",
        root: "/managed/openclaw",
        steps: [],
        durationMs: 1,
      },
    });
    closeOpenClawStateDatabase();
    await fs.writeFile(resolveOpenClawStateSqlitePath(env), "not sqlite");

    const claimed = await claimUpdateTransactionRollback({
      handoffId: "handoff-1",
      rollbackOwner: "rollback-external",
      reason: "candidate migration broke state",
      env,
    });

    expect(claimed?.payload.stats).toMatchObject({
      updatePhase: "rolling-back",
      updateRollbackOwner: "rollback-external",
      confirmationStatus: "failed",
    });
    expect((await readUpdateRecoveryJournal(journalPath)).payload.stats).toMatchObject({
      updatePhase: "rolling-back",
      updateRollbackOwner: "rollback-external",
    });
  });

  it("persists initiating channel fields and delivery confirmation", async () => {
    const env = await createEnv();
    await writeMarker(env, "delivery");
    const pending = await readRestartSentinel(env);
    expect(pending?.payload).toMatchObject({
      sessionKey: "agent:main:telegram:direct:chat-1",
      deliveryContext: { channel: "telegram", to: "chat-1", accountId: "default" },
      stats: {
        handoffId: "handoff-1",
        updatePhase: "restart",
        confirmationTier: "delivery",
        confirmationStatus: "pending",
      },
    });

    await markHealthy(env);
    await markUpdateTransactionDeliveryAck({ handoffId: "handoff-1", env });
    const confirmed = (await readRestartSentinel(env))!.payload;
    expect(isUpdateTransactionConfirmed(confirmed)).toBe(true);
    expect(isUpdateTransactionProbationReleased(confirmed)).toBe(false);
    expect(resolveUpdateTransactionStartupDisposition(confirmed)).toBe("probation");
    expect(
      await advanceUpdateTransactionMarker({
        handoffId: "handoff-1",
        phase: "confirm",
        env,
      }),
    ).not.toBeNull();

    await markUpdateTransactionProbationReleased({ handoffId: "handoff-1", env });
    const released = (await readRestartSentinel(env))!.payload;
    expect(isUpdateTransactionProbationReleased(released)).toBe(true);
    expect(resolveUpdateTransactionStartupDisposition(released)).toBe("normal");
  });

  it("requires a matching inbound reply for the human tier", async () => {
    const env = await createEnv();
    const marker = await writeMarker(env, "human");
    const confirmationChallenge = marker.payload.stats!.humanConfirmationChallenge!;
    await markHealthy(env);
    await markUpdateTransactionDeliveryAck({ handoffId: "handoff-1", env });
    expect(isUpdateTransactionConfirmed((await readRestartSentinel(env))!.payload)).toBe(false);

    await markUpdateTransactionHumanReply({
      handoffId: "handoff-1",
      sessionKey: "agent:main:telegram:direct:other",
      channel: "telegram",
      to: "chat-1",
      accountId: "default",
      confirmationChallenge,
      env,
    });
    expect((await readRestartSentinel(env))?.payload.stats?.confirmationStatus).toBe(
      "delivery-acked",
    );

    await markUpdateTransactionHumanReply({
      handoffId: "handoff-1",
      sessionKey: "agent:main:telegram:direct:chat-1",
      channel: "telegram",
      to: "chat-1",
      accountId: "default",
      confirmationChallenge: "wrong-challenge",
      env,
    });
    expect((await readRestartSentinel(env))?.payload.stats?.confirmationStatus).toBe(
      "delivery-acked",
    );

    await markUpdateTransactionHumanReply({
      handoffId: "handoff-1",
      sessionKey: "agent:main:telegram:direct:chat-1",
      channel: "telegram",
      to: "chat-1",
      accountId: "default",
      confirmationChallenge,
      env,
    });
    expect((await readRestartSentinel(env))?.payload.stats?.confirmationStatus).toBe(
      "human-confirmed",
    );
  });

  it("requires the durable initiating thread for human confirmation", async () => {
    const env = await createEnv();
    const marker = await writeUpdateTransactionMarker({
      env,
      confirmationTier: "human",
      meta: {
        handoffId: "handoff-1",
        sessionKey: "agent:main:telegram:direct:chat-1",
        deliveryContext: { channel: "telegram", to: "chat-1" },
        threadId: "topic-1",
      },
      result: {
        status: "ok",
        mode: "npm",
        root: "/managed/openclaw",
        steps: [],
        durationMs: 10,
      },
    });
    await markHealthy(env);
    await markUpdateTransactionDeliveryAck({ handoffId: "handoff-1", env });
    const confirmationChallenge = marker.payload.stats!.humanConfirmationChallenge!;

    expect(
      await markUpdateTransactionHumanReply({
        handoffId: "handoff-1",
        sessionKey: "agent:main:telegram:direct:chat-1",
        channel: "telegram",
        to: "chat-1",
        threadId: "topic-2",
        confirmationChallenge,
        env,
      }),
    ).toBeNull();
    expect(
      await markUpdateTransactionHumanReply({
        handoffId: "handoff-1",
        sessionKey: "agent:main:telegram:direct:chat-1",
        channel: "telegram",
        to: "chat-1",
        threadId: "topic-1",
        confirmationChallenge,
        env,
      }),
    ).not.toBeNull();
  });

  it("records timeout and failed transitions", async () => {
    const env = await createEnv();
    await writeMarker(env, "delivery");
    await markHealthy(env);
    let now = 0;
    expect(
      await waitForUpdateTransactionConfirmation({
        handoffId: "handoff-1",
        rollbackOwner: "rollback-1",
        timeoutMs: 5,
        pollMs: 2,
        env,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }),
    ).toBe(false);
    expect((await readRestartSentinel(env))?.payload.stats).toMatchObject({
      updatePhase: "rolling-back",
      confirmationStatus: "timed-out",
    });

    await advanceUpdateTransactionMarker({
      handoffId: "handoff-1",
      rollbackOwner: "rollback-1",
      phase: "failed",
      confirmationStatus: "failed",
      reason: "state restore failed",
      status: "error",
      env,
    });
    expect((await readRestartSentinel(env))?.payload).toMatchObject({
      status: "error",
      stats: {
        updatePhase: "failed",
        confirmationStatus: "failed",
        reason: "state restore failed",
      },
    });
  });

  it("preserves confirmation at the timeout boundary", async () => {
    const env = await createEnv();
    await writeMarker(env, "delivery");
    await markHealthy(env);
    let now = 0;
    let sleeps = 0;
    expect(
      await waitForUpdateTransactionConfirmation({
        handoffId: "handoff-1",
        rollbackOwner: "rollback-1",
        timeoutMs: 5,
        pollMs: 5,
        env,
        now: () => now,
        sleep: async () => {
          sleeps += 1;
          if (sleeps === 1) {
            now = 5;
            await markUpdateTransactionDeliveryAck({ handoffId: "handoff-1", env });
          } else {
            await markUpdateTransactionProbationReleased({ handoffId: "handoff-1", env });
          }
        },
      }),
    ).toBe(true);
    expect(sleeps).toBe(2);
    expect((await readRestartSentinel(env))?.payload.stats?.confirmationStatus).toBe(
      "delivery-acked",
    );
  });

  it("keeps confirmation irrevocable against stale failure transitions", async () => {
    const env = await createEnv();
    await writeMarker(env, "delivery");
    await markHealthy(env);
    await markUpdateTransactionDeliveryAck({ handoffId: "handoff-1", env });

    expect(
      await advanceUpdateTransactionMarker({
        handoffId: "handoff-1",
        phase: "failed",
        confirmationStatus: "failed",
        reason: "late failure",
        status: "error",
        env,
      }),
    ).toBeNull();
    expect((await readRestartSentinel(env))?.payload).toMatchObject({
      status: "skipped",
      stats: {
        updatePhase: "confirm",
        confirmationStatus: "delivery-acked",
      },
    });
  });

  it("heals a staged journal instead of rolling back confirmed SQLite state", async () => {
    const env = await createEnv();
    const journalPath = path.join(env.OPENCLAW_STATE_DIR!, "recovery-journal.json");
    env[UPDATE_RECOVERY_JOURNAL_ENV] = journalPath;
    await writeUpdateTransactionMarker({
      env,
      confirmationTier: "delivery",
      meta: { handoffId: "handoff-1" },
      phase: "healthy",
      rollback: {
        packageRoot: "/managed/openclaw",
        retainedPackageRoot: "/managed/.openclaw-previous",
        stateSnapshotRoot: "/managed/.openclaw-previous-state",
        nodePath: process.execPath,
        recoveryJournalPath: journalPath,
      },
      result: {
        status: "ok",
        mode: "npm",
        root: "/managed/openclaw",
        steps: [],
        durationMs: 1,
      },
    });
    const pending = (await readRestartSentinel(env))!.payload;
    const confirmed = {
      ...pending,
      stats: {
        ...pending.stats,
        updatePhase: "confirm" as const,
        confirmationStatus: "delivery-acked" as const,
      },
    };
    await rewriteUpdateRecoveryJournal({
      filePath: journalPath,
      handoffId: "handoff-1",
      stageConfirmation: true,
      rewrite: () => confirmed,
    });
    await refreshUpdateTransactionOwnerLease({ handoffId: "handoff-1", env });
    expect((await readUpdateRecoveryJournal(journalPath)).payload.stats).toMatchObject({
      updatePhase: "confirm",
      confirmationStatus: "delivery-acked",
    });
    await writeRestartSentinel(confirmed, env);

    await expect(
      claimUpdateTransactionRollback({
        handoffId: "handoff-1",
        rollbackOwner: "stale-owner",
        reason: "stale timeout",
        env,
      }),
    ).resolves.toBeNull();
    expect((await readUpdateRecoveryJournal(journalPath)).committedPayload.stats).toMatchObject({
      updatePhase: "confirm",
      confirmationStatus: "delivery-acked",
    });
  });

  it("rejects a delivery acknowledgement after rollback begins", async () => {
    const env = await createEnv();
    await writeMarker(env, "delivery");
    await advanceUpdateTransactionMarker({
      handoffId: "handoff-1",
      phase: "rolling-back",
      confirmationStatus: "timed-out",
      env,
    });
    expect(await markUpdateTransactionDeliveryAck({ handoffId: "handoff-1", env })).toBeNull();
    expect((await readRestartSentinel(env))?.payload.stats?.confirmationStatus).toBe("timed-out");
  });

  it("claims an expired owner lease and rejects backward phase races", async () => {
    const env = await createEnv();
    const marker = await writeMarker(env, "delivery");
    expect(isActiveUpdateTransactionMarker(marker.payload)).toBe(true);
    const leaseExpiresAt = marker.payload.stats?.updateOwnerLeaseExpiresAtMs;
    expect(typeof leaseExpiresAt).toBe("number");

    await claimExpiredUpdateTransactionOwner({
      handoffId: "handoff-1",
      rollbackOwner: "watchdog-1",
      now: leaseExpiresAt! + 1,
      env,
    });
    expect(
      await advanceUpdateTransactionMarker({
        handoffId: "handoff-1",
        phase: "healthy",
        env,
      }),
    ).toBeNull();
    const claimed = (await readRestartSentinel(env))!.payload;
    expect(claimed.stats).toMatchObject({
      updatePhase: "rolling-back",
      updateRollbackOwner: "watchdog-1",
      confirmationStatus: "timed-out",
      reason: "update orchestrator lease expired",
    });
    expect(isActiveUpdateTransactionMarker(claimed)).toBe(false);
  });

  it("allows exactly one rollback owner and rejects confirmed rollback", async () => {
    const env = await createEnv();
    await writeMarker(env, "delivery");
    expect(
      await claimUpdateTransactionRollback({
        handoffId: "handoff-1",
        rollbackOwner: "rollback-1",
        reason: "health failed",
        env,
      }),
    ).not.toBeNull();
    expect(
      await claimUpdateTransactionRollback({
        handoffId: "handoff-1",
        rollbackOwner: "rollback-2",
        reason: "competing rollback",
        env,
      }),
    ).toBeNull();
    expect(
      await advanceUpdateTransactionMarker({
        handoffId: "handoff-1",
        rollbackOwner: "rollback-2",
        phase: "failed",
        env,
      }),
    ).toBeNull();

    const confirmedEnv = await createEnv();
    await writeMarker(confirmedEnv, "delivery");
    await markHealthy(confirmedEnv);
    await markUpdateTransactionDeliveryAck({ handoffId: "handoff-1", env: confirmedEnv });
    expect(
      await claimUpdateTransactionRollback({
        handoffId: "handoff-1",
        rollbackOwner: "rollback-3",
        reason: "too late",
        env: confirmedEnv,
      }),
    ).toBeNull();
  });

  it("treats an omitted account id as the default account for human confirmation", async () => {
    const env = await createEnv();
    const marker = await writeUpdateTransactionMarker({
      env,
      confirmationTier: "human",
      meta: {
        handoffId: "handoff-1",
        sessionKey: "agent:main:telegram:direct:chat-1",
        deliveryContext: { channel: "telegram", to: "chat-1" },
      },
      result: {
        status: "ok",
        mode: "npm",
        root: "/managed/openclaw",
        steps: [],
        durationMs: 10,
      },
    });
    await markHealthy(env);
    await markUpdateTransactionDeliveryAck({ handoffId: "handoff-1", env });
    await markUpdateTransactionHumanReply({
      handoffId: "handoff-1",
      sessionKey: "agent:main:telegram:direct:chat-1",
      channel: "telegram",
      to: "chat-1",
      accountId: "default",
      confirmationChallenge: marker.payload.stats!.humanConfirmationChallenge!,
      env,
    });
    expect((await readRestartSentinel(env))?.payload.stats?.confirmationStatus).toBe(
      "human-confirmed",
    );
  });
});
