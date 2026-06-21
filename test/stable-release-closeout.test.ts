import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalJsonWithNewline,
  releasePolicySha256,
  sha256Hex,
} from "../scripts/lib/release-policy-evidence.mjs";
import {
  extractStableChangelogSection,
  parseStableReleaseTag,
  verifyStableMainCloseout,
  verifyStrictStableMainCloseout,
} from "../scripts/lib/stable-release-closeout.mjs";
import { stableReleaseLinesSha256 } from "../scripts/lib/stable-release-lines.mjs";

const release = {
  tagName: "v2026.6.8",
  isDraft: false,
  isPrerelease: false,
  assets: [
    { name: "OpenClaw-2026.6.8.zip", digest: `sha256:${"a".repeat(64)}` },
    { name: "OpenClaw-2026.6.8.dmg", digest: `sha256:${"b".repeat(64)}` },
    { name: "OpenClaw-2026.6.8.dSYM.zip", digest: `sha256:${"c".repeat(64)}` },
  ],
};
const changelog =
  "# Changelog\n\n## 2026.6.8\n\n### Fixes\n\n- Shipped fix.\n\n## 2026.6.7\n\n- Old.\n";
const validCloseoutParams = {
  tag: "v2026.6.8",
  mainPackageJson: { version: "2026.6.8" },
  tagPackageJson: { version: "2026.6.8" },
  mainChangelog: changelog,
  tagChangelog: changelog,
  mainAppcast:
    "https://github.com/openclaw/openclaw/releases/download/v2026.6.8/OpenClaw-2026.6.8.zip\n",
  release,
  releaseTagSha: "tag-sha",
  mainSha: "main-sha",
  fullReleaseValidationRunId: "11",
  releasePublishRunId: "12",
  rollbackDrillId: "rollback-drill-2026-q2",
  rollbackDrillDate: "2026-06-01",
};

const digest = (value: string) => value.repeat(64);
const sha = (value: string) => value.repeat(40);

function strictStableLines(version: "2026.6.33" | "2026.6.34") {
  const isBase = version === "2026.6.33";
  return {
    version: 1,
    lines: [
      {
        month: "2026.6",
        baseVersion: "2026.6.33",
        branch: "stable/2026.6.33",
        status: isBase ? "planned" : "active",
        publishedVersions: isBase ? [] : ["2026.6.33"],
        publicationEvidence: isBase
          ? []
          : [
              {
                version: "2026.6.33",
                evidenceRef: "closeout/2026.6.33",
                evidenceSha256: digest("9"),
              },
            ],
        currentVersion: isBase ? null : "2026.6.33",
        supportStartedOn: isBase ? null : "2026-06-30",
        targetRotationOn: "2026-07-31",
        retiredOn: null,
        rollbackTarget: { kind: "selector-unset" },
      },
    ],
    lastTransition: isBase
      ? {
          operation: "plan",
          fromVersion: null,
          toVersion: null,
          publishedVersion: null,
          proofRef: null,
          proofSha256: null,
          effectiveDate: "2026-06-01",
        }
      : {
          operation: "activate",
          fromVersion: null,
          toVersion: "2026.6.33",
          publishedVersion: null,
          proofRef: "handoff/2026.6.33",
          proofSha256: digest("8"),
          effectiveDate: "2026-06-30",
        },
  };
}

function strictCloseoutParams(
  version: "2026.6.33" | "2026.6.34" = "2026.6.33",
  identities = { policy: sha("a"), source: sha("b"), tag: sha("c") },
) {
  const stableLines = strictStableLines(version);
  const releaseClass = version.endsWith(".33") ? "stable-base" : "stable-patch";
  const tag = `v${version}`;
  const sourceRef = "refs/heads/stable/2026.6.33";
  const section = `## ${version}\n\n### Fixes\n\n- Stable fix.`;
  const policy = {
    version: 1,
    releaseVersion: version,
    releaseClass,
    releaseSelector: "stable",
    policyMode: "strict",
    publishEligible: true,
    authorizedSourceRef: sourceRef,
    policySource: {
      sha: identities.policy,
      blobs: {
        releaseVersionPolicySha256: digest("1"),
        stableReleaseLinesModuleSha256: digest("2"),
        verifyReleaseOperationSha256: digest("3"),
        stableLinesSha256: stableReleaseLinesSha256(stableLines),
      },
    },
  };
  const changelogEvidence = {
    tag,
    sourceRef,
    sectionHeading: `## ${version}`,
    sectionSha256: sha256Hex(section),
  };
  const publishManifest = {
    version: 1,
    releasePolicy: policy,
    releasePolicySha256: releasePolicySha256(policy),
    preflight: { runId: "100", runAttempt: "1", payloadSha256: digest("4") },
    fullValidation: { runId: "101", runAttempt: "1", payloadSha256: digest("5") },
    execution: {
      event: "workflow_dispatch",
      workflowPath: ".github/workflows/openclaw-release-publish.yml",
      executionRef: sourceRef,
      runHeadSha: sha("d"),
      runId: "102",
      runAttempt: "1",
    },
    target: {
      targetRef: `refs/tags/${tag}`,
      targetSha: identities.tag,
      releaseTag: tag,
      authorizedSourceRef: sourceRef,
      authorizedSourceTipSha: identities.source,
      targetReachableFromAuthorizedSource: true,
    },
    changelogEvidence,
  };
  const publishManifestBytes = Buffer.from(canonicalJsonWithNewline(publishManifest));
  const publishDescriptor = {
    runId: "102",
    runAttempt: "1",
    artifactName: "release-publish-manifest-102-1",
    payloadSha256: sha256Hex(publishManifestBytes),
  };
  const postpublishEvidence = {
    version: 2,
    releaseVersion: version,
    releaseTag: tag,
    npmDistTag: "stable",
    pluginSelection: [],
    openclawNpmIntegrity: "sha512-openclaw",
    openclawNpmTarball: `openclaw-${version}.tgz`,
    npmRegistrySignaturesVerified: true,
    npmProvenanceAttestationMatched: true,
    githubReleaseUrl: `https://github.com/openclaw/openclaw/releases/tag/${tag}`,
    pluginNpmPackageCount: 0,
    clawHubPackageCount: 0,
    workflowRuns: [{ id: "101", label: "Full Release Validation" }],
    releasePublishRunId: "102",
    releasePublishRunAttempt: "1",
    releasePolicy: policy,
    releasePolicySha256: releasePolicySha256(policy),
    publishManifest: publishDescriptor,
    changelogEvidence,
  };
  const postpublishEvidenceBytes = Buffer.from(canonicalJsonWithNewline(postpublishEvidence));
  const releaseAssets = [
    { name: `OpenClaw-${version}.zip`, digest: `sha256:${digest("a")}` },
    { name: `OpenClaw-${version}.dmg`, digest: `sha256:${digest("b")}` },
    { name: `OpenClaw-${version}.dSYM.zip`, digest: `sha256:${digest("c")}` },
  ];
  return {
    tag,
    policyMainSha: identities.policy,
    stableSourceSha: identities.source,
    releaseTagSha: identities.tag,
    policyMainAppcast: `<rss xmlns:sparkle="urn:sparkle"><channel><item><sparkle:shortVersionString>${version}</sparkle:shortVersionString><enclosure url="https://github.com/openclaw/openclaw/releases/download/${tag}/OpenClaw-${version}.zip"/></item></channel></rss>\n`,
    stableLines,
    stableSourcePackageJson: { version },
    tagPackageJson: { version },
    stableSourceChangelog: `# Changelog\n\n${section}\n\n## 2026.6.32\n\n- Old.\n`,
    tagChangelog: `# Changelog\n\n${section}\n\n## 2026.6.32\n\n- Old.\n`,
    release: { tagName: tag, isDraft: false, isPrerelease: false, assets: releaseAssets },
    publishManifest,
    publishManifestBytes,
    publishDescriptor,
    postpublishEvidence,
    postpublishEvidenceBytes,
    postpublishDescriptor: {
      runId: "102",
      runAttempt: "1",
      artifactName: `openclaw-release-postpublish-evidence-v${version}`,
      payloadSha256: sha256Hex(postpublishEvidenceBytes),
    },
    fullReleaseValidationRunId: "101",
    releasePublishRunId: "102",
    rollbackDrillId: "rollback-drill-2026-q2",
    rollbackDrillDate: "2026-06-01",
    nowMs: Date.parse("2026-06-17T00:00:00Z"),
  };
}

function createGitCheckout(root: string, files: Record<string, string>) {
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "release-test@openclaw.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Release Test"]);
  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

function replaceStrictPolicy(
  params: ReturnType<typeof strictCloseoutParams>,
  policy: typeof params.publishManifest.releasePolicy,
) {
  const changelogEvidence = {
    ...params.publishManifest.changelogEvidence,
    sourceRef: policy.authorizedSourceRef,
  };
  const publishManifest = {
    ...params.publishManifest,
    releasePolicy: policy,
    releasePolicySha256: releasePolicySha256(policy),
    target: {
      ...params.publishManifest.target,
      authorizedSourceRef: policy.authorizedSourceRef,
    },
    changelogEvidence,
  };
  const publishManifestBytes = Buffer.from(canonicalJsonWithNewline(publishManifest));
  const publishDescriptor = {
    ...params.publishDescriptor,
    payloadSha256: sha256Hex(publishManifestBytes),
  };
  const postpublishEvidence = {
    ...params.postpublishEvidence,
    releasePolicy: policy,
    releasePolicySha256: releasePolicySha256(policy),
    publishManifest: publishDescriptor,
    changelogEvidence,
  };
  const postpublishEvidenceBytes = Buffer.from(canonicalJsonWithNewline(postpublishEvidence));
  return {
    ...params,
    publishManifest,
    publishManifestBytes,
    publishDescriptor,
    postpublishEvidence,
    postpublishEvidenceBytes,
    postpublishDescriptor: {
      ...params.postpublishDescriptor,
      payloadSha256: sha256Hex(postpublishEvidenceBytes),
    },
  };
}

describe("stable release closeout", () => {
  it("parses stable and correction tags", () => {
    expect(parseStableReleaseTag("v2026.6.8")).toBe("2026.6.8");
    expect(parseStableReleaseTag("v2026.6.8-2")).toBe("2026.6.8");
    expect(() => parseStableReleaseTag("v2026.6.8-0")).toThrow("expected a stable release tag");
    expect(() => parseStableReleaseTag("v2026.6.8-beta.1")).toThrow(
      "expected a stable release tag",
    );
  });

  it("extracts only the requested stable changelog section", () => {
    expect(extractStableChangelogSection(changelog, "2026.6.8")).toBe(
      "## 2026.6.8\n\n### Fixes\n\n- Shipped fix.",
    );
  });

  it("accepts an exact stable closeout with a current rollback drill", () => {
    const result = verifyStableMainCloseout({
      ...validCloseoutParams,
      nowMs: Date.parse("2026-06-17T00:00:00Z"),
    });

    expect(result.errors).toEqual([]);
    expect(result.manifest).toMatchObject({
      releaseTag: "v2026.6.8",
      releaseVersion: "2026.6.8",
      rollbackDrill: { id: "rollback-drill-2026-q2", date: "2026-06-01" },
    });
    expect(result.manifest).not.toHaveProperty("verifiedAt");
  });

  it("writes identical closeout evidence when replayed", () => {
    const first = verifyStableMainCloseout({
      ...validCloseoutParams,
      nowMs: Date.parse("2026-06-17T00:00:00Z"),
    });
    const replay = verifyStableMainCloseout({
      ...validCloseoutParams,
      release: {
        ...release,
        assets: [
          ...release.assets,
          {
            name: "openclaw-2026.6.8-stable-main-closeout.json",
            digest: `sha256:${"d".repeat(64)}`,
          },
          {
            name: "openclaw-2026.6.8-stable-main-closeout.json.sha256",
            digest: `sha256:${"e".repeat(64)}`,
          },
        ],
      },
      nowMs: Date.parse("2026-06-18T00:00:00Z"),
    });

    expect(replay.manifest).toEqual(first.manifest);
  });

  it("replays an existing partial closeout using its recorded rollback drill", () => {
    const first = verifyStableMainCloseout({
      ...validCloseoutParams,
      nowMs: Date.parse("2026-06-17T00:00:00Z"),
    });
    const replay = verifyStableMainCloseout({
      ...validCloseoutParams,
      allowStaleRollbackDrill: true,
      nowMs: Date.parse("2026-10-01T00:00:00Z"),
    });

    expect(replay.errors).toEqual([]);
    expect(replay.manifest).toEqual(first.manifest);
  });

  it("requires the canonical macOS zip, dmg, and dSYM assets", () => {
    const result = verifyStableMainCloseout({
      ...validCloseoutParams,
      release: {
        ...release,
        assets: [{ name: "openclaw-2026.6.8-dependency-evidence.zip" }],
      },
      mainAppcast:
        "https://github.com/openclaw/openclaw/releases/download/v2026.6.8/openclaw-2026.6.8-dependency-evidence.zip\n",
      nowMs: Date.parse("2026-06-17T00:00:00Z"),
    });

    expect(result.errors).toContain(
      "GitHub release v2026.6.8 is missing required macOS asset(s): OpenClaw-2026.6.8.zip, OpenClaw-2026.6.8.dmg, OpenClaw-2026.6.8.dSYM.zip.",
    );
  });

  it("uses exact correction versions for correction-release state and assets", () => {
    const correctionRelease = {
      ...release,
      tagName: "v2026.6.8-2",
      assets: release.assets.map((asset) => ({
        ...asset,
        name: asset.name.replaceAll("2026.6.8", "2026.6.8-2"),
      })),
    };
    const result = verifyStableMainCloseout({
      ...validCloseoutParams,
      tag: "v2026.6.8-2",
      mainPackageJson: { version: "2026.6.8-2" },
      tagPackageJson: { version: "2026.6.8-2" },
      mainChangelog: changelog.replaceAll("2026.6.8", "2026.6.8-2"),
      tagChangelog: changelog.replaceAll("2026.6.8", "2026.6.8-2"),
      release: correctionRelease,
      mainAppcast:
        "https://github.com/openclaw/openclaw/releases/download/v2026.6.8-2/OpenClaw-2026.6.8-2.zip\n",
      nowMs: Date.parse("2026-06-17T00:00:00Z"),
    });

    expect(result.errors).toEqual([]);
    expect(result.manifest).toMatchObject({
      releaseVersion: "2026.6.8-2",
      mainPackageVersion: "2026.6.8-2",
      releaseTagPackageVersion: "2026.6.8-2",
    });
  });

  it("allows a fallback correction tag for an existing base stable package", () => {
    const result = verifyStableMainCloseout({
      ...validCloseoutParams,
      tag: "v2026.6.8-2",
      release: {
        ...release,
        tagName: "v2026.6.8-2",
      },
      mainAppcast:
        "https://github.com/openclaw/openclaw/releases/download/v2026.6.8-2/OpenClaw-2026.6.8.zip\n",
      nowMs: Date.parse("2026-06-17T00:00:00Z"),
    });

    expect(result.errors).toEqual([]);
    expect(result.manifest).toMatchObject({
      releaseVersion: "2026.6.8",
      mainPackageVersion: "2026.6.8",
      releaseTagPackageVersion: "2026.6.8",
    });
  });

  it("rejects calendar-normalized rollback drill dates", () => {
    const result = verifyStableMainCloseout({
      ...validCloseoutParams,
      rollbackDrillDate: "2026-02-31",
      nowMs: Date.parse("2026-06-17T00:00:00Z"),
    });

    expect(result.errors).toContain("rollback drill date is invalid: 2026-02-31.");
  });

  it("rejects speculative main state, appcast drift, and stale rollback drills", () => {
    const result = verifyStableMainCloseout({
      ...validCloseoutParams,
      mainPackageJson: { version: "2026.6.9" },
      mainChangelog: changelog.replace("Shipped fix.", "Different fix."),
      mainAppcast: "https://example.test/old.zip\n",
      rollbackDrillId: "rollback-drill-2026-q1",
      rollbackDrillDate: "2026-03-01",
      nowMs: Date.parse("2026-06-17T00:00:00Z"),
    });

    expect(result.errors).toContain(
      "main package.json version is 2026.6.9, expected shipped version 2026.6.8.",
    );
    expect(result.errors).toContain(
      "main CHANGELOG.md ## 2026.6.8 does not exactly match the shipped release section.",
    );
    expect(result.errors).toContain(
      "main appcast.xml does not point at OpenClaw-2026.6.8.zip from v2026.6.8.",
    );
    expect(result.errors).toContain(
      "rollback drill is older than 90 days: 2026-03-01. Run the private rollback drill before stable closeout.",
    );
  });

  it.each(["2026.6.33", "2026.6.34"] as const)(
    "writes closed v2 evidence for trailing stable %s",
    (version) => {
      const params = strictCloseoutParams(version);
      const result = verifyStrictStableMainCloseout(params);

      expect(result.errors).toEqual([]);
      expect(result.manifest).toEqual({
        version: 2,
        releaseTag: `v${version}`,
        releaseVersion: version,
        policyMainSha: sha("a"),
        stableSourceSha: sha("b"),
        stableSourcePackageVersion: version,
        releaseTagSha: sha("c"),
        releaseTagPackageVersion: version,
        changelogSha256: params.publishManifest.changelogEvidence.sectionSha256,
        appcastSha256: sha256Hex(params.policyMainAppcast),
        fullReleaseValidationRunId: "101",
        releasePublishRunId: "102",
        rollbackDrill: { id: "rollback-drill-2026-q2", date: "2026-06-01" },
        githubReleaseAssets: params.release.assets,
        releasePolicy: params.publishManifest.releasePolicy,
        releasePolicySha256: params.publishManifest.releasePolicySha256,
        publishManifest: params.publishDescriptor,
        postpublishEvidence: params.postpublishDescriptor,
        changelogEvidence: params.publishManifest.changelogEvidence,
      });
      expect(result.manifest).not.toHaveProperty("mainSha");
      expect(result.manifest).not.toHaveProperty("mainPackageVersion");
    },
  );

  it("rejects recorded commit, selected-ref, and descriptor identity drift", () => {
    const params = strictCloseoutParams();
    const mismatchedPolicy = {
      ...params.publishManifest.releasePolicy,
      authorizedSourceRef: "refs/heads/stable/other",
    };
    const mismatchedEvidence = replaceStrictPolicy(params, mismatchedPolicy);
    const result = verifyStrictStableMainCloseout({
      ...mismatchedEvidence,
      policyMainSha: sha("f"),
      stableSourceSha: sha("e"),
      releaseTagSha: sha("d"),
      publishDescriptor: {
        ...mismatchedEvidence.publishDescriptor,
        payloadSha256: digest("0"),
      },
    });

    expect(result.manifest).toBeNull();
    expect(result.errors.join("\n")).toContain("policy-main SHA");
    expect(result.errors.join("\n")).toContain("stable-source SHA");
    expect(result.errors.join("\n")).toContain("release-tag SHA");
    expect(result.errors.join("\n")).toContain("publish descriptor payload digest");
    expect(result.errors.join("\n")).toContain("metadata-selected stable ref");
  });

  it("rejects exact changelog byte drift after identity validation", () => {
    const params = strictCloseoutParams();
    const result = verifyStrictStableMainCloseout({
      ...params,
      stableSourceChangelog: params.stableSourceChangelog.replace("Stable fix", "Drifted fix"),
    });

    expect(result.manifest).toBeNull();
    expect(result.errors).toContain(
      "stable source and release tag changelog sections do not exactly match.",
    );
  });

  it("requires the stable release to be the leading appcast item", () => {
    const params = strictCloseoutParams();
    const historical = `<item><sparkle:shortVersionString>2026.5.33</sparkle:shortVersionString><enclosure url="https://github.com/openclaw/openclaw/releases/download/v2026.5.33/OpenClaw-2026.5.33.zip"/></item>`;
    const result = verifyStrictStableMainCloseout({
      ...params,
      policyMainAppcast: params.policyMainAppcast.replace("<item>", `${historical}<item>`),
    });

    expect(result.manifest).toBeNull();
    expect(result.errors).toContain(
      "policy-main appcast.xml does not select v2026.6.33 as its leading item.",
    );
  });

  it("rejects daily before stable-only asset and rollback validation", () => {
    const params = strictCloseoutParams();
    const dailyPolicy = {
      ...params.publishManifest.releasePolicy,
      releaseClass: "daily",
      releaseSelector: "daily",
      authorizedSourceRef: "refs/heads/main",
      policySource: {
        ...params.publishManifest.releasePolicy.policySource,
        blobs: {
          ...params.publishManifest.releasePolicy.policySource.blobs,
          stableLinesSha256: null,
        },
      },
    };
    const dailyParams = replaceStrictPolicy(params, dailyPolicy);
    const result = verifyStrictStableMainCloseout({
      ...dailyParams,
      stableLines: null,
      rollbackDrillId: "",
      release: { ...params.release, assets: [] },
    });

    expect(result.manifest).toBeNull();
    expect(result.errors.join("\n")).toContain('Release selector "daily" does not match');
    expect(result.errors.join("\n")).not.toContain("macOS asset");
    expect(result.errors.join("\n")).not.toContain("rollback drill");
  });

  it("materializes exact recorded checkouts and rejects a moved source checkout", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "stable-closeout-v2-"));
    try {
      const version = "2026.6.33" as const;
      const tag = `v${version}`;
      const section = `## ${version}\n\n### Fixes\n\n- Stable fix.`;
      const changelogBytes = `# Changelog\n\n${section}\n\n## 2026.6.32\n\n- Old.\n`;
      const appcast = `<rss xmlns:sparkle="urn:sparkle"><channel><item><sparkle:shortVersionString>${version}</sparkle:shortVersionString><enclosure url="https://github.com/openclaw/openclaw/releases/download/${tag}/OpenClaw-${version}.zip"/></item></channel></rss>\n`;
      const stableLines = strictStableLines(version);
      const policyDir = join(temporaryRoot, "policy");
      const sourceDir = join(temporaryRoot, "source");
      const tagDir = join(temporaryRoot, "tag");
      const policySha = createGitCheckout(policyDir, {
        "appcast.xml": appcast,
        "release/stable-lines.json": canonicalJsonWithNewline(stableLines),
      });
      const sourceSha = createGitCheckout(sourceDir, {
        "package.json": canonicalJsonWithNewline({ version }),
        "CHANGELOG.md": changelogBytes,
      });
      const tagSha = createGitCheckout(tagDir, {
        "package.json": canonicalJsonWithNewline({ version }),
        "CHANGELOG.md": changelogBytes,
      });
      const params = strictCloseoutParams(version, {
        policy: policySha,
        source: sourceSha,
        tag: tagSha,
      });
      const inputDir = join(temporaryRoot, "inputs");
      mkdirSync(inputDir);
      const inputs = {
        release: join(inputDir, "release.json"),
        publish: join(inputDir, "publish.json"),
        publishDescriptor: join(inputDir, "publish-descriptor.json"),
        postpublish: join(inputDir, "postpublish.json"),
        postpublishDescriptor: join(inputDir, "postpublish-descriptor.json"),
        output: join(inputDir, "closeout.json"),
      };
      for (const [path, value] of [
        [inputs.release, params.release],
        [inputs.publish, params.publishManifest],
        [inputs.publishDescriptor, params.publishDescriptor],
        [inputs.postpublish, params.postpublishEvidence],
        [inputs.postpublishDescriptor, params.postpublishDescriptor],
      ] as const) {
        writeFileSync(path, canonicalJsonWithNewline(value));
      }
      const script = join(process.cwd(), "scripts/verify-stable-main-closeout.mjs");
      const args = [
        script,
        "--tag",
        tag,
        "--policy-main-dir",
        policyDir,
        "--policy-main-sha",
        policySha,
        "--stable-source-dir",
        sourceDir,
        "--stable-source-sha",
        sourceSha,
        "--release-tag-dir",
        tagDir,
        "--release-tag-sha",
        tagSha,
        "--release-json",
        inputs.release,
        "--publish-manifest",
        inputs.publish,
        "--publish-descriptor",
        inputs.publishDescriptor,
        "--postpublish-evidence",
        inputs.postpublish,
        "--postpublish-descriptor",
        inputs.postpublishDescriptor,
        "--full-release-validation-run-id",
        "101",
        "--release-publish-run-id",
        "102",
        "--rollback-drill-id",
        "rollback-drill-2026-q2",
        "--rollback-drill-date",
        "2026-06-01",
        "--output",
        inputs.output,
      ];
      const success = spawnSync(process.execPath, args, {
        cwd: temporaryRoot,
        encoding: "utf8",
      });
      expect(success.status, success.stderr).toBe(0);
      expect(JSON.parse(readFileSync(inputs.output, "utf8"))).toMatchObject({
        version: 2,
        policyMainSha: policySha,
        stableSourceSha: sourceSha,
        releaseTagSha: tagSha,
      });

      writeFileSync(join(sourceDir, "moved.txt"), "new tip\n");
      execFileSync("git", ["-C", sourceDir, "add", "."]);
      execFileSync("git", ["-C", sourceDir, "commit", "-qm", "move branch"]);
      const movedOutput = join(inputDir, "moved-closeout.json");
      const moved = spawnSync(process.execPath, [...args.slice(0, -1), movedOutput], {
        cwd: temporaryRoot,
        encoding: "utf8",
      });
      expect(moved.status).toBe(1);
      expect(moved.stderr).toContain("stable-source-dir HEAD");
      expect(moved.stderr).toContain(`does not match ${sourceSha}`);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("checks out recorded strict commits instead of moving stable refs", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github/workflows/openclaw-stable-main-closeout.yml"),
      "utf8",
    );

    expect(workflow).toContain("ref: ${{ needs.resolve.outputs.policy_main_sha }}");
    expect(workflow).toContain("path: policy-main");
    expect(workflow).toContain("ref: ${{ needs.resolve.outputs.stable_source_sha }}");
    expect(workflow).toContain("needs.resolve.outputs.release_tag_sha ||");
    expect(workflow).toContain('scripts/verify-release-operation.mjs" verify');
    expect(workflow).toContain('--policy-main-dir "$GITHUB_WORKSPACE/policy-main"');
    expect(workflow).toContain("candidate_tags < <(gh_with_retry release list");
    expect(workflow).toContain("releasePolicy.releaseClass // empty");
    expect(workflow).toContain("openclaw-release-postpublish-evidence-${RELEASE_TAG}");
    expect(workflow).toContain("release-publish-artifacts.json");
    expect(workflow).toContain("release asset differs from the authenticated postpublish artifact");
    expect(workflow).not.toContain("ref: ${{ needs.resolve.outputs.stable_source_ref }}");
    expect(workflow.indexOf('early_release_class="$(jq -r')).toBeLessThan(
      workflow.indexOf("Verify stable state and write closeout manifest"),
    );
  });
});
