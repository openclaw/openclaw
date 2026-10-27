import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import * as fixtures from "./session-cost-usage-fixtures.test-support.js";
import {
  decodeUsageCostPartition as decodePartition,
  partitionUsageCostRollup as partitionRollup,
} from "./session-cost-usage-partitions.js";
import {
  decodeUsageCostRollup as decodeRollup,
  decodeUsageCostRollupEnvelope as decodeEnvelope,
  encodeUsageCostRollup as encodeRollup,
} from "./session-cost-usage-rollup-codec.js";
import {
  appendSessionUsageRollupContribution,
  createSessionUsageRollupData,
} from "./session-cost-usage-rollup.js";

function entry(records: number) {
  const rollup = createSessionUsageRollupData();
  for (let index = 0; index < records; index++) {
    appendSessionUsageRollupContribution(rollup, {
      timestamp: 1_000 + index,
      role: "assistant",
      model: "雪🦞é",
      provider: "synthetic",
      toolNames: ["read", "雪🦞"],
      toolResultCounts: { total: 0, errors: 0 },
      usageTotals: {
        ...rollup.untimestamped.totals,
        input: 1,
        totalTokens: 1,
        totalCost: index === 0 ? 1e16 : 0.1,
      },
    });
  }
  return fixtures.createUsageRollupEntry(rollup, {
    pricingFingerprint: "synthetic-pricing",
    checkpoint: fixtures.createUsageCheckpoint(100, 1_000, 2),
    scannedAt: 2_000,
    parsedRecords: records,
    countedRecords: records,
  });
}

it.each([0, 512])("round-trips %i records with exact Unicode and numeric buckets", (records) => {
  const original = entry(records);
  const { valueJson, blob } = encodeRollup(original);
  const metadata = decodeEnvelope(valueJson, original.pricingFingerprint);
  expect(metadata).toMatchObject({
    body: {
      bytes: Buffer.byteLength(JSON.stringify(original.rollup)),
      utf16Length: JSON.stringify(original.rollup).length,
    },
  });
  expect(valueJson).not.toContain('"buckets"');
  expect(Buffer.byteLength(valueJson)).toBeLessThan(1024);
  expect(decodeRollup(valueJson, original.pricingFingerprint, blob)).toEqual(original);
  expect(metadata?.body.encoding).toBe(records > 0 ? "zstd" : "identity");
  if (records > 0) {
    expect(blob.byteLength).toBeLessThan(metadata!.body.bytes / 4);
  }
});

it("rejects damaged or mismatched bodies and unsupported envelope versions", () => {
  const original = entry(512);
  const encoded = encodeRollup(original);
  const metadata = JSON.parse(encoded.valueJson);
  const corrupt = (fields: Record<string, unknown>) => JSON.stringify({ ...metadata, ...fields });
  const body = (fields: Record<string, unknown>) =>
    corrupt({ body: { ...metadata.body, ...fields } });
  const damaged = Uint8Array.from(encoded.blob, (byte, index) =>
    index === encoded.blob.length - 1 ? byte ^ 1 : byte,
  );
  for (const [valueJson, blob] of [
    [encoded.valueJson, damaged],
    [encoded.valueJson, encoded.blob.subarray(1)],
    [encoded.valueJson, null],
    [corrupt({ format: 999 }), encoded.blob],
    [corrupt({ version: 5 }), encoded.blob],
    [body({ bytes: 1 }), encoded.blob],
    [body({ utf16Length: metadata.body.utf16Length + 1 }), encoded.blob],
  ] as const) {
    expect(decodeRollup(valueJson, original.pricingFingerprint, blob)).toBeUndefined();
  }
  expect(decodeRollup(encoded.valueJson, "different-pricing", encoded.blob)).toBeUndefined();
});

it.each([
  ["rollup", 0],
  ["rollup", 512],
  ["partition", 1],
  ["partition", 512],
] as const)("rejects impossible %s lengths before deferring %i records", (kind, records) => {
  const original = entry(records);
  const { valueJson, blob } =
    kind === "rollup"
      ? encodeRollup(original)
      : expectDefined(partitionRollup(original).partitions[0], "Expected usage partition");
  const metadata = JSON.parse(valueJson);
  const header = kind === "rollup" ? metadata.body : metadata;
  const decode = (json: string) =>
    kind === "rollup"
      ? decodeRollup(json, original.pricingFingerprint, blob, { remainingBytes: 0 })
      : decodePartition(json, blob, { remainingBytes: 0 });
  for (const body of [
    { ...header, bytes: 35 * 1024 * 1024, ...(kind === "partition" && { encoding: "identity" }) },
    { ...header, bytes: blob.byteLength + 1, encoding: "identity" },
    { ...header, bytes: blob.byteLength, encoding: "zstd" },
  ]) {
    expect(
      decode(JSON.stringify(kind === "rollup" ? { ...metadata, body } : body)),
    ).toBeUndefined();
  }
  expect(decode(valueJson)).toBeNull();
  if (kind === "partition") {
    expect(decodePartition(valueJson, blob)).toMatchObject({
      buckets: { "0": { totals: { totalTokens: records } } },
    });
  }
});
