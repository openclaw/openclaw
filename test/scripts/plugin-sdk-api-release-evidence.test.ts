import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPluginSdkApiDiffSet as createDiffSet,
  encodePluginSdkApiArtifact as encode,
  decodePluginSdkApiArtifact as decode,
  expandPluginSdkApiDiffSet as expandDiffs,
  selectPluginSdkApiReleaseEvidence as selectEvidence,
  createPluginSdkApiReleaseEvidence as createEvidence,
  createPluginSdkApiReleaseEvidenceSet as createEvidenceSet,
  validatePluginSdkApiReleaseEvidence,
} from "../../scripts/plugin-sdk-api-release-evidence.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const workflowSha = "d".repeat(40);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function diff(exports: unknown[] = []) {
  const payload = { entrypointsAdded: [], entrypointsRemoved: [], exports };
  return {
    ...payload,
    digest: createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex"),
  };
}

function evidence(exports: unknown[] = []) {
  return createEvidence({
    baseRef: "v2026.8.1",
    baseSha,
    diff: diff(exports),
    headSha,
    workflowSha,
  });
}

function validate(
  receipt: unknown,
  overrides: Partial<Parameters<typeof validatePluginSdkApiReleaseEvidence>[0]> = {},
) {
  return validatePluginSdkApiReleaseEvidence({
    acknowledgement: "",
    evidence: receipt,
    expectedHeadSha: headSha,
    expectedWorkflowSha: workflowSha,
    ...overrides,
  });
}

describe("Plugin SDK API release evidence", () => {
  it("enforces selectors acknowledgement through the release CLI", () => {
    const receipt = evidence([{ change: "added", exportName: "send" }]);
    const manifestPath = join(tempDirs.make("plugin-sdk-evidence-"), "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        pluginSdkApi: encode(createEvidenceSet({ beta: evidence(), latest: receipt })),
      }),
    );
    const run = (acknowledgement?: string) =>
      spawnSync(
        process.execPath,
        [
          "scripts/plugin-sdk-api-release-evidence.mjs",
          "--manifest",
          manifestPath,
          "--head",
          headSha,
          "--workflow-sha",
          workflowSha,
          "--npm-dist-tag",
          "latest",
          ...(acknowledgement ? ["--acknowledge", acknowledgement] : []),
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );

    for (const acknowledgement of [undefined, "deadbeef"]) {
      const rejected = run(acknowledgement);
      expect(rejected.status, rejected.stderr).toBe(1);
      expect(rejected.stderr).toContain("require acknowledgement digest");
    }
    const accepted = run(receipt.digest.slice(0, 8));
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({ hasChanges: true, status: "checked" });
  });

  it("round-trips oversized shared comparisons under the unchanged 16 MiB file cap", () => {
    const beta = evidence([{ declaration: "x".repeat(9 * 1024 * 1024) }]);
    const latest = { ...beta, baseRef: "v2026.7.31", baseSha: "c".repeat(40) };
    const selectors = { beta, latest };
    const legacy = { schema: "openclaw.plugin-sdk-api-release-evidence-set/v1", selectors };
    const compactBytes = JSON.stringify(createEvidenceSet(selectors));
    const compact = JSON.parse(compactBytes);
    expect(Buffer.byteLength(JSON.stringify(legacy))).toBeGreaterThan(16 * 1024 * 1024);
    expect(Buffer.byteLength(compactBytes)).toBeLessThan(16 * 1024 * 1024);
    expect(Object.keys(compact.diffs)).toEqual([beta.digest]);
    const report = createDiffSet({ beta: beta.diff, latest: latest.diff });
    const reportBytes = JSON.stringify(report);
    expect(Buffer.byteLength(reportBytes)).toBeLessThan(16 * 1024 * 1024);
    expect(expandDiffs(JSON.parse(reportBytes))).toEqual({
      beta: beta.diff,
      latest: latest.diff,
    });
    for (const npmDistTag of ["beta", "latest"] as const) {
      expect(selectEvidence({ evidence: compact, npmDistTag })).toEqual(selectors[npmDistTag]);
      const input = {
        acknowledgement: beta.digest.slice(0, 8),
        npmDistTag,
      };
      expect(validate(compact, input)).toEqual(validate(legacy, input));
    }
  });

  it("preserves distinct overlapping comparisons and logical digests in bounded transport", () => {
    const declaration = "declare interface Shared { value: string; }\n".repeat(1000);
    const beta = evidence([{ declaration, change: "added" }]);
    const latest = evidence([{ declaration, change: "removed" }]);
    const logical = createEvidenceSet({ beta, latest });
    const encodedBytes = JSON.stringify(encode(logical));
    const encoded = JSON.parse(encodedBytes);
    expect(encodedBytes.length).toBeLessThan(JSON.stringify(logical).length / 2);
    expect(decode(encoded)).toEqual(logical);
    for (const npmDistTag of ["beta", "latest"] as const) {
      const receipt = { beta, latest }[npmDistTag];
      expect(selectEvidence({ evidence: encoded, npmDistTag })).toEqual(receipt);
      expect(
        validate(encoded, { npmDistTag, acknowledgement: receipt.digest.slice(0, 8) }),
      ).toMatchObject({ digest: receipt.digest });
    }
    const report = createDiffSet({ beta: beta.diff, latest: latest.diff });
    expect(expandDiffs(encode(report))).toEqual({
      beta: beta.diff,
      latest: latest.diff,
    });
    expect(
      selectEvidence({
        evidence: encode(beta),
        npmDistTag: "beta",
      }),
    ).toEqual(beta);
  });

  it("rejects malformed transport, nested envelopes and bounded expansion bombs", () => {
    const encoded = encode(evidence());
    for (const invalid of [
      { ...encoded, data: encoded.data + "!" },
      { ...encoded, data: Buffer.from("not gzip").toString("base64") },
      { ...encoded, encoding: "brotli+base64" },
      { ...encoded, extra: true },
      { ...encoded, data: "A".repeat(16 * 1024 * 1024 + 1) },
      encode(encoded),
    ]) {
      expect(() => decode(invalid)).toThrow();
    }
    const bomb = {
      ...encoded,
      data: gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1, 32)).toString("base64"),
    };
    expect(() => decode(bomb)).toThrow();
    const beta = evidence([{ declaration: "beta" }]);
    const latest = evidence([{ declaration: "latest" }]);
    const logical = createEvidenceSet({ beta, latest });
    const latestDiff = logical.diffs[latest.digest];
    if (!latestDiff) {
      throw new Error("Missing latest comparison fixture");
    }
    latestDiff.exports.push({ declaration: "tampered unselected comparison" });
    expect(() =>
      selectEvidence({
        evidence: encode(logical),
        npmDistTag: "beta",
      }),
    ).toThrow("digest does not match");
  });

  it("rejects missing, extra, redirected and modified pooled comparisons", () => {
    const beta = evidence([{ change: "added", exportName: "betaOnly" }]);
    const latest = evidence([{ change: "removed", exportName: "latestOnly" }]);
    const compact = createEvidenceSet({ beta, latest });
    const validateBeta = (value: unknown) =>
      validate(value, { acknowledgement: beta.digest.slice(0, 8), npmDistTag: "beta" });
    for (const mutate of [
      (value: typeof compact) => {
        delete value.diffs[beta.digest];
      },
      (value: typeof compact) => {
        value.diffs["f".repeat(64)] = beta.diff;
      },
      (value: typeof compact) => {
        value.selectors.beta.diff = latest.digest;
      },
      (value: typeof compact) => {
        const latestDiff = value.diffs[latest.digest];
        if (!latestDiff) {
          throw new Error("Missing latest comparison fixture");
        }
        latestDiff.exports.push({ changed: true });
      },
    ]) {
      const changed = structuredClone(compact);
      mutate(changed);
      expect(() => validateBeta(changed)).toThrow();
    }
    expect(validateBeta(compact)).toMatchObject({ digest: beta.digest });
    expect(expandDiffs(createDiffSet({ beta: beta.diff, latest: latest.diff }))).toEqual({
      beta: beta.diff,
      latest: latest.diff,
    });
  });

  it("rejects evidence for another release SHA or a changed diff payload", () => {
    const receipt = evidence([{ change: "added", exportName: "send" }]);
    const acknowledgement = receipt.digest.slice(0, 8);
    expect(() => validate(receipt, { acknowledgement, expectedHeadSha: "c".repeat(40) })).toThrow(
      "head SHA does not match",
    );

    const changed = structuredClone(receipt);
    changed.diff.exports.push({ change: "removed", exportName: "receive" });
    expect(() => validate(changed, { acknowledgement })).toThrow("digest does not match");
  });

  it("rejects a preflight receipt when the npm dist-tag predecessor moved", () => {
    const receipt = evidence();
    const validateSelector = (currentSelectorRef: string, currentSelectorSha: string) =>
      validate(receipt, { currentSelectorRef, currentSelectorSha, targetRef: "v2026.8.2" });

    expect(validateSelector("v2026.8.1", baseSha)).toMatchObject({ status: "checked" });
    expect(() => validateSelector("v2026.8.1-1", "c".repeat(40))).toThrow(
      "predecessor no longer matches the npm dist-tag",
    );
    expect(validateSelector("v2026.8.2", headSha)).toMatchObject({ status: "checked" });
    expect(() => validateSelector("v2026.8.2", "c".repeat(40))).toThrow(
      "dist-tag target does not match the release SHA",
    );
  });

  it("requires the selected channel's predecessor and acknowledgement", () => {
    const beta = evidence([{ change: "added", exportName: "betaOnly" }]);
    const latest = createEvidence({
      baseRef: "v2026.7.31",
      baseSha: "c".repeat(40),
      diff: diff([{ change: "removed", exportName: "oldStable" }]),
      headSha,
      workflowSha,
    });
    const bundle = createEvidenceSet({ beta, latest });
    const validateSelector = (
      npmDistTag: string,
      predecessor = latest,
      acknowledgement = latest.digest.slice(0, 8),
    ) =>
      validate(bundle, {
        acknowledgement,
        currentSelectorRef: predecessor.baseRef,
        currentSelectorSha: predecessor.baseSha,
        npmDistTag,
        targetRef: "v2026.8.2",
      });

    expect(validateSelector("latest")).toMatchObject({ digest: latest.digest });
    expect(validateSelector("beta", beta, beta.digest.slice(0, 8))).toMatchObject({
      digest: beta.digest,
    });
    expect(() => validateSelector("latest", beta)).toThrow("predecessor no longer matches");
    expect(() => validateSelector("latest", latest, beta.digest.slice(0, 8))).toThrow(
      "require acknowledgement",
    );
    expect(() => validateSelector("alpha")).toThrow("beta or latest");
    expect(() => validateSelector("")).toThrow("beta or latest");
    expect(() => createEvidenceSet({ beta })).toThrow("bind beta and latest");
    expect(() => createEvidenceSet({ beta, latest: { ...latest, headSha: baseSha } })).toThrow(
      "one release and tooling SHA",
    );
    expect(() => createEvidenceSet({ beta, latest: { ...latest, workflowSha: baseSha } })).toThrow(
      "one release and tooling SHA",
    );
  });

  it("rejects untrusted tooling and unavailable evidence", () => {
    const receipt = evidence();
    expect(() => validate(receipt, { expectedWorkflowSha: undefined })).toThrow(
      "Expected Plugin SDK API evidence workflow SHA",
    );
    expect(() => validate(receipt, { expectedWorkflowSha: "f".repeat(40) })).toThrow(
      "workflow SHA does not match trusted tooling",
    );
    expect(() => validate({ ...receipt, status: "unavailable" })).toThrow("invalid status");
  });
});
