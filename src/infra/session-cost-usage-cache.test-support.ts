import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect } from "vitest";
import { normalizeAgentId } from "../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  readSessionCostUsageRollupRowsInDatabase,
  readSessionCostUsageRollupBodyInDatabase,
  type SessionCostUsageRollupRow,
} from "./session-cost-usage-cache.kernel.js";
import { prepareSessionCostUsageRefreshLock } from "./session-cost-usage-cache.sqlite.js";
import {
  decodeUsageCostRollup,
  decodeUsageCostRollupEnvelope,
  encodeUsageCostRollup,
} from "./session-cost-usage-rollup-codec.js";

export function readSessionCostUsageRollupRows(
  agentId?: string,
  databasePath?: string,
): SessionCostUsageRollupRow[] {
  const result = withOpenClawAgentDatabaseReadOnly(
    ({ db }) => readSessionCostUsageRollupRowsInDatabase(db),
    { agentId: normalizeAgentId(agentId), ...(databasePath ? { path: databasePath } : {}) },
  );
  return result.found ? result.value : [];
}

/** Seed the obsolete tool-count semantics through the real cache writer and its CAS fence. */
export async function writeLegacyUsageCostRollupForTest(sessionFile: string): Promise<void> {
  const currentRow = expectDefined(
    readSessionCostUsageRollupRows("main").find((row) => row.key === sessionFile),
    "expected current usage rollup",
  );
  const currentRollup = expectDefined(
    readSessionCostUsageRollupEntry(currentRow, "main"),
    "decoded usage rollup",
  );
  currentRollup.version = 4;
  currentRollup.rollup.untimestamped.totals.totalTokens = 9_999;
  for (const bucket of [
    currentRollup.rollup.untimestamped,
    ...Object.values(currentRollup.rollup.buckets),
  ]) {
    bucket.messageCounts.toolCalls = 1;
    bucket.tools = [{ name: "read", count: 1 }];
  }
  const lock = prepareSessionCostUsageRefreshLock("main");
  const encoded = encodeUsageCostRollup(currentRollup);
  try {
    expect(await lock.acquire()).toBe(true);
    expect(
      await lock.writeRollup({
        rollupId: sessionFile,
        previousValueJson: Buffer.from(currentRow.valueJson),
        valueJson: Buffer.from(encoded.valueJson),
        blob: encoded.blob,
        updatedAt: currentRow.updatedAt + 1,
      }),
    ).toBe(true);
  } finally {
    await lock.release();
  }
}

export function readSessionCostUsageRollupEntry(
  row: SessionCostUsageRollupRow,
  agentId?: string,
  databasePath?: string,
) {
  const envelope = decodeUsageCostRollupEnvelope(row.valueJson);
  if (!envelope) {
    return undefined;
  }
  const result = withOpenClawAgentDatabaseReadOnly(
    ({ db }) => {
      const body = readSessionCostUsageRollupBodyInDatabase(db, row);
      return body
        ? decodeUsageCostRollup(row.valueJson, envelope.pricingFingerprint, body.blob)
        : undefined;
    },
    { agentId: normalizeAgentId(agentId), ...(databasePath ? { path: databasePath } : {}) },
  );
  return result.found ? result.value : undefined;
}
