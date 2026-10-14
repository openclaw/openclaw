/** Retains explicit promotion notice and claim provenance. */
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  executeOpenClawStateWorker,
  runOpenClawStateWorkerOperation,
} from "../state/openclaw-state-worker-store.js";

type PromotionClaimRecord = {
  slug: string;
  provider?: string;
  modelKeys: string[];
  endsAtMs: number;
  claimedAtMs: number;
};

export async function markPromotionSlugsNotified(slugs: Iterable<string>): Promise<void> {
  try {
    const input = { slugs: [...slugs], now: Date.now() };
    if (input.slugs.length === 0) {
      return;
    }
    const context = captureOpenClawStateWorkerContext();
    const command = { type: "promotions.markNotified", input } as const;
    const completed = await runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute(command),
      { existingOnly: true },
    );
    if (completed === undefined) {
      await executeOpenClawStateWorker(context, command);
    }
  } catch {
    // Notice provenance must not fail an explicit promotion command.
  }
}

export async function recordPromotionClaim(record: PromotionClaimRecord): Promise<void> {
  try {
    const input = {
      slug: record.slug,
      provider: record.provider ?? null,
      modelKeysJson: JSON.stringify(record.modelKeys),
      endsAtMs: record.endsAtMs,
      claimedAtMs: record.claimedAtMs,
    };
    const context = captureOpenClawStateWorkerContext();
    await executeOpenClawStateWorker(context, { type: "promotions.recordClaim", input });
  } catch {
    // Provenance is annotation-only; a failed write must never fail a claim.
  }
}
