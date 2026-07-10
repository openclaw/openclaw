import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  consumeReleaseLedgerRunEvidence,
  validateReleaseLedgerChangelog,
  validateReleaseLedgerManifest,
} from "../../scripts/validate-release-ledger-evidence.mjs";

const workflowSha = "1".repeat(40);
const toolingTree = "2".repeat(40);
const sourceSha = "3".repeat(40);
const releaseSha = "4".repeat(40);

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(nameValue: string, bytes: Buffer): Buffer {
  const name = Buffer.from(nameValue, "utf8");
  const checksum = crc32(bytes);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(name.length, 26);
  const centralOffset = local.length + name.length + bytes.length;
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE((0o100600 * 0x10000) >>> 0, 38);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, bytes, central, name, end]);
}

function fixture(overrides: { maxChangelogTail?: number; unresolved?: unknown[] } = {}) {
  const section = [
    "## 2026.7.1",
    "",
    "### Complete contribution record",
    "",
    `This audited record covers the complete v2026.6.11..${sourceSha} history: 1 merged PR. The generation manifest also supplies direct commits as editorial input; the grouped notes above prioritize user impact.`,
    "",
    "- **PR #1** fix: example.",
  ].join("\n");
  const changelog = `# Changelog\n\n${section}\n`;
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
    artifacts: {
      changelogSha256: sha256(changelog),
      releaseSectionSha256: sha256(section),
    },
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
    changelog,
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

  it("binds the ledger base, source, version, and hashes to the tag changelog", () => {
    const { bytes, changelog } = fixture();
    const manifest = JSON.parse(bytes.toString("utf8"));
    expect(validateReleaseLedgerChangelog(manifest, changelog, "v2026.7.1-beta.3")).toEqual({
      baseRef: "v2026.6.11",
      releaseRef: "release/2026.7.1",
      sourceSha,
      version: "2026.7.1",
    });
    expect(validateReleaseLedgerChangelog(manifest, changelog, "v2026.7.1-2")).toEqual({
      baseRef: "v2026.6.11",
      releaseRef: "release/2026.7.1",
      sourceSha,
      version: "2026.7.1",
    });
    const dedicatedChangelog = changelog.replace("## 2026.7.1", "## 2026.7.1-2");
    const dedicatedManifest = {
      ...manifest,
      artifacts: {
        changelogSha256: sha256(dedicatedChangelog),
        releaseSectionSha256: sha256(dedicatedChangelog.slice("# Changelog\n\n".length).trimEnd()),
      },
      version: "2026.7.1-2",
    };
    expect(
      validateReleaseLedgerChangelog(dedicatedManifest, dedicatedChangelog, "v2026.7.1-2"),
    ).toEqual({
      baseRef: "v2026.6.11",
      releaseRef: "release/2026.7.1",
      sourceSha,
      version: "2026.7.1-2",
    });
    expect(() =>
      validateReleaseLedgerChangelog(
        manifest,
        changelog.replace("PR #1", "PR #2"),
        "v2026.7.1-beta.3",
      ),
    ).toThrow("ledger changelog hash does not match the release tag");
  });

  it("consumes one immutable attempt-1 artifact and rechecks live release refs", async () => {
    const { bytes, changelog } = fixture();
    const archive = storedZip("release-ledger-manifest.json", bytes);
    const runId = 77;
    const artifactId = 88;
    const run = {
      id: runId,
      run_attempt: 1,
      head_sha: workflowSha,
      head_branch: "main",
      event: "workflow_dispatch",
      path: ".github/workflows/release-ledger.yml",
      status: "completed",
      conclusion: "success",
      repository: { full_name: "openclaw/openclaw" },
      head_repository: { full_name: "openclaw/openclaw" },
    };
    const artifact = {
      id: artifactId,
      name: "release-ledger-evidence",
      expired: false,
      digest: `sha256:${sha256(archive)}`,
      size_in_bytes: archive.length,
      workflow_run: { id: runId, head_sha: workflowSha },
    };
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/actions/runs/${runId}`)) return Response.json(run);
      if (url.endsWith(`/actions/runs/${runId}/artifacts?per_page=100`)) {
        return Response.json({ total_count: 1, artifacts: [artifact] });
      }
      if (url.endsWith(`/actions/artifacts/${artifactId}`)) return Response.json(artifact);
      if (url.endsWith(`/actions/runs/${runId}/attempts/1`)) return Response.json(run);
      if (url.endsWith(`/actions/artifacts/${artifactId}/zip`)) {
        return new Response(archive, {
          headers: { "content-length": String(archive.length) },
        });
      }
      if (url.endsWith("/git/ref/heads/main")) {
        return Response.json({ object: { type: "commit", sha: "9".repeat(40) } });
      }
      if (url.endsWith(`/compare/${workflowSha}...${"9".repeat(40)}`)) {
        return Response.json({ merge_base_commit: { sha: workflowSha } });
      }
      if (
        url.includes("/git/ref/heads/release/2026.7.1") ||
        url.includes("/git/ref/tags/v2026.7.1-beta.3")
      ) {
        return Response.json({ object: { type: "commit", sha: releaseSha } });
      }
      throw new Error(`unexpected request: ${url}`);
    };
    await expect(
      consumeReleaseLedgerRunEvidence({
        changelog,
        expectedReleaseSha: releaseSha,
        fetchImpl,
        releaseTag: "v2026.7.1-beta.3",
        repository: "openclaw/openclaw",
        runId,
        token: "test-token",
      }),
    ).resolves.toMatchObject({
      artifactId,
      baseRef: "v2026.6.11",
      releaseSha,
      runAttempt: 1,
      runId,
      sourceSha,
      workflowSha,
    });
    await expect(
      consumeReleaseLedgerRunEvidence({
        changelog,
        expectedReleaseSha: "5".repeat(40),
        fetchImpl,
        releaseTag: "v2026.7.1-beta.3",
        repository: "openclaw/openclaw",
        runId,
        token: "test-token",
      }),
    ).rejects.toThrow("live release tag does not match the checked-out release SHA");
  });

  it("rejects a rerun before downloading publication evidence", async () => {
    const { changelog } = fixture();
    const fetchImpl = async () =>
      Response.json({
        id: 77,
        run_attempt: 2,
        head_sha: workflowSha,
        head_branch: "main",
        event: "workflow_dispatch",
        path: ".github/workflows/release-ledger.yml",
        status: "completed",
        conclusion: "success",
        repository: { full_name: "openclaw/openclaw" },
        head_repository: { full_name: "openclaw/openclaw" },
      });
    await expect(
      consumeReleaseLedgerRunEvidence({
        changelog,
        expectedReleaseSha: releaseSha,
        fetchImpl,
        releaseTag: "v2026.7.1-beta.3",
        repository: "openclaw/openclaw",
        runId: 77,
        token: "test-token",
      }),
    ).rejects.toThrow("not an exact successful trusted-main attempt-1 producer");
  });
});
