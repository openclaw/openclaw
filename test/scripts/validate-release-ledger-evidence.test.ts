import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateReleaseLedgerManifest } from "../../scripts/validate-release-ledger-evidence.mjs";

const workflowSha = "1".repeat(40);
const toolingTree = "2".repeat(40);
const sourceSha = "3".repeat(40);
const releaseSha = "4".repeat(40);

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function fixture(overrides: { maxChangelogTail?: number; unresolved?: unknown[] } = {}) {
  const invocationCore = {
    base: "v2026.6.11",
    comparisonBase: "main",
    maxChangelogTail: overrides.maxChangelogTail ?? 1,
    shippedRefs: ["v2026.6.11"],
    sourceTarget: sourceSha,
    target: releaseSha,
    toolingCommit: workflowSha,
    toolingTree,
    version: "2026.7.1",
    writeLedger: true,
  };
  const inventoryCore = {
    comparison: {
      partitionAudit: { missing: [], overlaps: [], unexpected: [] },
      unclassified: { count: 0 },
    },
    complete: true,
    schemaVersion: 4,
    unresolved: overrides.unresolved ?? [],
  };
  const manifest = {
    artifacts: {},
    base: "v2026.6.11",
    directCommits: [],
    directReconciliation: {},
    finalTarget: releaseSha,
    inventory: {
      ...inventoryCore,
      sha256: sha256(`${JSON.stringify(inventoryCore)}\n`),
    },
    invocation: {
      ...invocationCore,
      sha256: sha256(`${JSON.stringify(invocationCore)}\n`),
    },
    mergeBase: "5".repeat(40),
    pullRequests: [],
    reconciliation: {
      coverage: 1,
      generatedCoverage: 1,
      generatedMissingRows: { count: 0 },
      generatedUnexpectedRows: { count: 0 },
      missingRows: { count: 0 },
      staleRows: { count: 0 },
    },
    reconciliations: {},
    schemaVersion: 6,
    seedAuthorization: null,
    shippedBaselines: [],
    source: {},
    status: "pass",
    target: sourceSha,
    tooling: {
      trustedSource: {
        commit: workflowSha,
        tree: toolingTree,
      },
    },
    unlinkedCommits: [],
    version: "2026.7.1",
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  return {
    bytes,
    expected: {
      baseRef: "v2026.6.11",
      manifestSha256: sha256(bytes),
      releaseSha,
      sourceSha,
      toolingTree,
      version: "2026.7.1",
      workflowSha,
    },
  };
}

describe("release ledger evidence validator", () => {
  it("accepts a complete schema-v6 ledger bound to trusted tooling", () => {
    const { bytes, expected } = fixture();
    expect(validateReleaseLedgerManifest(bytes, expected)).toMatchObject({
      finalTarget: releaseSha,
      schemaVersion: 6,
      status: "pass",
      target: sourceSha,
    });
  });

  it("rejects a widened changelog tail", () => {
    const { bytes, expected } = fixture({ maxChangelogTail: 2 });
    expect(() => validateReleaseLedgerManifest(bytes, expected)).toThrow(
      "must allow exactly one changelog commit",
    );
  });

  it("rejects unresolved contribution inventory", () => {
    const { bytes, expected } = fixture({ unresolved: [{ commit: "6".repeat(40) }] });
    expect(() => validateReleaseLedgerManifest(bytes, expected)).toThrow(
      "ledger inventory has unresolved commits",
    );
  });
});
