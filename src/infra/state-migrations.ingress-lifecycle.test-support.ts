import { expect } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createChannelIngressQueue } from "../channels/message/ingress-queue.js";
import type { PluginDoctorStateMigration } from "../plugins/doctor-contract-module.js";

export async function expectRecoveryPredicateRefusedAfterRepair(params: {
  stateDir: string;
  runMigration: (migration: PluginDoctorStateMigration) => Promise<void>;
}): Promise<void> {
  const { promise: predicateGate, resolve: releasePredicate } = createDeferred();
  const { promise: predicateEntered, resolve: markPredicateEntered } = createDeferred();
  let recovery: Promise<void> | undefined;
  let predicateStarted = false;
  let recoveryOutcome: string | undefined;
  const seeded = createChannelIngressQueue<{ note: string }>({
    channelId: "line",
    accountId: "default",
    stateDir: params.stateDir,
  });
  await seeded.enqueue("latch-evt", { note: "seeded" });
  const claimed = await seeded.claimNext({ ownerId: "retired-owner" });
  expect(claimed?.id).toBe("latch-evt");

  try {
    await params.runMigration({
      id: "line-ingress-latch-test",
      label: "LINE ingress latch test",
      detectLegacyState: () => ({ preview: ["ingress latch preview"] }),
      async migrateLegacyState({ context }) {
        const line = (context.channelIngressQueues ?? []).find(
          (entry) => entry.channelId === "line",
        );
        const open = line?.openChannelIngressQueue;
        if (!open) {
          throw new Error("Expected the repair's ingress queue");
        }
        const queue = open<{ note: string }>({ accountId: "default" });
        // Recovery remains pending after this section returns, but native preparation must finish first.
        recovery = queue
          .recoverStaleClaims({
            staleMs: 0,
            shouldRecover: async () => {
              predicateStarted = true;
              markPredicateEntered();
              await predicateGate;
              return true;
            },
          })
          .then(() => {
            recoveryOutcome = "completed";
          })
          .catch((error: unknown) => {
            recoveryOutcome = String(error);
          });
        await Promise.race([predicateEntered, recovery]);
        return { changes: ["ingress latch test migrated"], warnings: [] };
      },
    });

    expect(predicateStarted).toBe(true);
  } finally {
    releasePredicate();
    await recovery;
  }
  expect(recoveryOutcome).toMatch(/ingress queue access has expired/i);
  // The durable claim stays held: the post-predicate write never reached SQLite.
  const claims = await createChannelIngressQueue<{ note: string }>({
    channelId: "line",
    accountId: "default",
    stateDir: params.stateDir,
  }).listClaims();
  expect(claims.map((claim) => claim.id)).toStrictEqual(["latch-evt"]);
}
