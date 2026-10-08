import { describe, expect, it } from "vitest";
import {
  decodeUsageCostRollup,
  decodeUsageCostRollupEnvelope,
  encodeUsageCostRollup,
  USAGE_COST_ROLLUP_VERSION,
  type UsageCostRollupEntry,
} from "./session-cost-usage-rollup-codec.js";
import {
  appendSessionUsageRollupContribution,
  createSessionUsageRollupData,
} from "./session-cost-usage-rollup.js";
import { createEmptyCostUsageTotals } from "./session-cost-usage-totals.js";
import { resolveZstdCodec } from "./zstd-codec.js";

function entry(records: number): UsageCostRollupEntry {
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
        ...createEmptyCostUsageTotals(),
        input: 1,
        totalTokens: 1,
        totalCost: index === 0 ? 1e16 : 0.1,
      },
    });
  }
  return {
    version: USAGE_COST_ROLLUP_VERSION,
    pricingFingerprint: "synthetic-pricing",
    checkpoint: {
      kind: "jsonl",
      parsedOffset: 100,
      observedSize: 100,
      observedMtimeMs: 1_000,
      device: 1,
      inode: 2,
      anchorHash: "anchor",
    },
    scannedAt: 2_000,
    parsedRecords: records,
    countedRecords: records,
    rollup,
  };
}

describe("usage rollup storage codec", () => {
  it.each([0, 512])("round-trips %i records with exact Unicode and numeric buckets", (records) => {
    const original = entry(records);
    const encoded = encodeUsageCostRollup(original);
    const metadata = decodeUsageCostRollupEnvelope(encoded.valueJson, original.pricingFingerprint);
    expect(metadata).toMatchObject({
      body: {
        bytes: Buffer.byteLength(JSON.stringify(original.rollup)),
        utf16Length: JSON.stringify(original.rollup).length,
      },
    });
    expect(encoded.valueJson).not.toContain('"buckets"');
    expect(Buffer.byteLength(encoded.valueJson)).toBeLessThan(1024);
    expect(
      decodeUsageCostRollup(encoded.valueJson, original.pricingFingerprint, encoded.blob),
    ).toEqual(original);
    if (records > 0 && resolveZstdCodec()) {
      expect(metadata?.body.encoding).toBe("zstd");
      expect(encoded.blob.byteLength).toBeLessThan(metadata!.body.bytes / 4);
    } else {
      expect(metadata?.body.encoding).toBe("identity");
    }
  });

  it("rejects damaged or mismatched bodies and unsupported envelope versions", () => {
    const original = entry(512);
    const encoded = encodeUsageCostRollup(original);
    const metadata = JSON.parse(encoded.valueJson);
    const damaged = Uint8Array.from(encoded.blob, (byte, index) =>
      index === encoded.blob.length - 1 ? byte ^ 1 : byte,
    );
    for (const [valueJson, blob] of [
      [encoded.valueJson, damaged],
      [encoded.valueJson, encoded.blob.subarray(1)],
      [encoded.valueJson, null],
      [JSON.stringify({ ...metadata, format: 999 }), encoded.blob],
      [JSON.stringify({ ...metadata, version: 5 }), encoded.blob],
      [JSON.stringify({ ...metadata, body: { ...metadata.body, bytes: 1 } }), encoded.blob],
      [
        JSON.stringify({
          ...metadata,
          body: { ...metadata.body, utf16Length: metadata.body.utf16Length + 1 },
        }),
        encoded.blob,
      ],
    ] as const) {
      expect(decodeUsageCostRollup(valueJson, original.pricingFingerprint, blob)).toBeUndefined();
    }
    expect(
      decodeUsageCostRollup(encoded.valueJson, "different-pricing", encoded.blob),
    ).toBeUndefined();
  });
});
