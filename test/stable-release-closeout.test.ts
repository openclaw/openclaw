import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  extractStableChangelogSection,
  findAppcastWithdrawal,
  parseStableReleaseTag,
  verifyStableMainCloseout,
} from "../scripts/lib/stable-release-closeout.mjs";

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
const releaseAssets = (names: string[]) =>
  names.map((name, index) => ({ name, digest: `sha256:${index.toString(16).repeat(64)}` }));
const macAssetNames = (version: string, suffix = "") =>
  ["zip", "dmg", "dSYM.zip"].map((extension) => `OpenClaw-${version}${suffix}.${extension}`);
const remainingAppAssets = [
  "OpenClaw-Android-SHA256SUMS.txt",
  "OpenClaw-Android.apk",
  "OpenClawCompanion-SHA256SUMS.txt",
  "OpenClawCompanion-Setup-arm64.exe",
  "OpenClawCompanion-Setup-x64.exe",
];
const completeAppAssets = [
  ...release.assets,
  ...remainingAppAssets.map((name) => ({ name, digest: `sha256:${"d".repeat(64)}` })),
];
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
  fullReleaseValidationRunAttempt: "2",
  releasePublishRunId: "12",
  rollbackDrillId: "rollback-drill-2026-q2",
  rollbackDrillDate: "2026-06-01",
  nowMs: Date.parse("2026-06-17T00:00:00Z"),
};
const appcastEvidenceError =
  "Recorded appcast evidence presence or format does not match canonical macOS release asset state.";
const changelogError =
  "main CHANGELOG.md ## 2026.6.8 does not exactly match the shipped release section.";
const errors = {
  attempt: "full release validation run attempt is invalid: <missing>.",
  calendar: "rollback drill date is invalid: 2026-02-31.",
  appcast: "main appcast.xml does not point at OpenClaw-2026.6.8.zip from v2026.6.8.",
  intel: "main appcast-x86_64.xml does not point at OpenClaw-2026.9.6-x86_64.zip from v2026.9.6.",
  platform: "Recorded app platform states do not match canonical release asset digests.",
  accounting:
    "main changelog 2026.6.8 frozen contribution record does not match the shipped release accounting.",
};
type CloseoutParams = Parameters<typeof verifyStableMainCloseout>[0];
function verify(params: CloseoutParams = {}) {
  return verifyStableMainCloseout({ ...validCloseoutParams, ...params });
}
function rejects(params: CloseoutParams, ...expectedErrors: string[]) {
  const result = verify(params);
  expect(result.errors).toEqual(expect.arrayContaining(expectedErrors));
  expect(result.manifest).toBeNull();
}
function succeeds(params: CloseoutParams) {
  const result = verify(params);
  expect(result.errors).toEqual([]);
  return result.manifest;
}
function expectReplay(params: CloseoutParams, manifest: ReturnType<typeof verify>["manifest"]) {
  expect(JSON.stringify(succeeds(params))).toBe(JSON.stringify(manifest));
}
function versionParams(
  version: string,
  releaseChangelog = changelog.replaceAll("2026.6.8", version),
) {
  return {
    tag: `v${version}`,
    mainPackageJson: { version },
    tagPackageJson: { version },
    mainChangelog: releaseChangelog,
    tagChangelog: releaseChangelog,
  };
}
type CloseoutOverrides = Partial<typeof validCloseoutParams> & {
  publishedAppcast?: string;
  mainArm64Appcast?: string;
  mainX86_64Appcast?: string;
};
const thinVersion = "2026.9.6";
const thinTag = `v${thinVersion}`;
const thinFeed = (suffix = "") =>
  `https://github.com/openclaw/openclaw/releases/download/${thinTag}/OpenClaw-${thinVersion}${suffix}.zip`;
const thinChangelog = `# Changelog\n\n## ${thinVersion}\n\n- Shipped thin macOS releases.\n`;
const thinCloseoutParams = {
  ...validCloseoutParams,
  ...versionParams(thinVersion, thinChangelog),
  release: {
    tagName: thinTag,
    isDraft: false,
    isPrerelease: false,
    assets: releaseAssets(
      ["", "-arm64", "-x86_64"].flatMap((suffix) => macAssetNames(thinVersion, suffix)),
    ),
  },
  mainAppcast: thinFeed(),
  mainArm64Appcast: thinFeed("-arm64"),
  mainX86_64Appcast: thinFeed("-x86_64"),
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function shippedReplayFixture(version: string, mainVersion: string, complete: boolean) {
  const tag = `v${version}`;
  const changelogSection = `## ${version}\n\n- Shipped release.`;
  const replayChangelog = `# Changelog\n\n${changelogSection}`;
  const mainAppcast = `https://github.com/openclaw/openclaw/releases/download/${tag}/OpenClaw-${version}.zip\n`;
  const githubReleaseAssets = releaseAssets([
    ...macAssetNames(version),
    ...(complete ? remainingAppAssets : []),
  ]);
  const manifest = {
    version: 2,
    releaseTag: tag,
    releaseVersion: version,
    releaseTagSha: "tag-sha",
    mainSha: "main-sha",
    mainPackageVersion: mainVersion,
    releaseTagPackageVersion: version,
    changelogSha256: sha256(changelogSection),
    ...(complete
      ? { appcastSha256: sha256(mainAppcast) }
      : {
          apps: "pending",
          appPlatforms: { macos: "attached", android: "pending", windows: "pending" },
          appcast: "verified",
          appcastSha256: sha256(mainAppcast),
        }),
    fullReleaseValidationRunId: "11",
    fullReleaseValidationRunAttempt: "2",
    releasePublishRunId: "12",
    ...(complete ? { releasePublishRecovery: { completePlatformAssetsRequired: true } } : {}),
    rollbackDrill: { id: "rollback-drill-2026-q2", date: "2026-06-01" },
    githubReleaseAssets,
  };
  return {
    label: `v${version} ${complete ? "omitted app-state fields" : "explicit pending app state"}`,
    manifest,
    params: {
      ...validCloseoutParams,
      ...versionParams(version, replayChangelog),
      mainPackageJson: { version: mainVersion },
      mainAppcast,
      release: { tagName: tag, isDraft: false, isPrerelease: false, assets: githubReleaseAssets },
      existingManifest: manifest,
      allowStaleRollbackDrill: true,
      nowMs: Date.parse("2026-10-01T00:00:00Z"),
    },
  };
}

const shippedJulyReplayFixture = shippedReplayFixture("2026.7.1", "2026.7.2", true);
const shippedSeptemberReplayFixture = shippedReplayFixture("2026.9.2", "2026.9.2", false);
const shippedReplayFixtures = [shippedJulyReplayFixture, shippedSeptemberReplayFixture];

describe("stable release closeout", () => {
  it("parses stable and correction tags", () => {
    expect(parseStableReleaseTag("v2026.6.8")).toBe("2026.6.8");
    expect(parseStableReleaseTag("v2026.6.8-2")).toBe("2026.6.8");
    expect(() => parseStableReleaseTag("v2026.6.8-0")).toThrow("expected a stable release tag");
    expect(() => parseStableReleaseTag("v2026.6.8-beta.1")).toThrow(
      "expected a stable release tag",
    );
  });

  it.each([
    ["exact correction", "2026.6.8-2", "2026.6.8-2"],
    ["fallback correction", "2026.6.8", "2026.6.9"],
  ])("records %s versions for release state and assets", (_name, version, mainVersion) => {
    const tag = "v2026.6.8-2";
    expect(
      verify({
        ...versionParams(version),
        tag,
        mainPackageJson: { version: mainVersion },
        release: {
          ...release,
          tagName: tag,
          assets: release.assets.map((asset) => ({
            ...asset,
            name: asset.name.replaceAll("2026.6.8", version),
          })),
        },
        mainAppcast: `https://github.com/openclaw/openclaw/releases/download/${tag}/OpenClaw-${version}.zip\n`,
      }),
    ).toMatchObject({
      errors: [],
      manifest: {
        releaseVersion: version,
        mainPackageVersion: mainVersion,
        releaseTagPackageVersion: version,
      },
    });
  });

  it.each<[string, CloseoutOverrides, ...string[]]>([
    ["missing validation attempt", { fullReleaseValidationRunAttempt: "" }, errors.attempt],
    [
      "stale Intel feed",
      {
        ...thinCloseoutParams,
        mainX86_64Appcast: "<rss>stale Intel feed</rss>",
        nowMs: Date.parse("2026-09-21T00:00:00Z"),
      },
      errors.intel,
    ],
    [
      "stale main snapshot despite valid published feed",
      {
        mainAppcast: "<rss>stale main feed</rss>",
        publishedAppcast:
          "https://github.com/openclaw/openclaw/releases/download/v2026.6.8/OpenClaw-2026.6.8.zip",
      },
      errors.appcast,
    ],
    ["invalid calendar date", { rollbackDrillDate: "2026-02-31" }, errors.calendar],
    [
      "older main, appcast drift, and stale rollback drill",
      {
        mainPackageJson: { version: "2026.6.7" },
        mainChangelog: changelog.replace("Shipped fix.", "Different fix."),
        mainAppcast: "https://example.test/old.zip\n",
        rollbackDrillId: "rollback-drill-2026-q1",
        rollbackDrillDate: "2026-03-01",
      },
      "main package.json version is 2026.6.7, expected shipped version 2026.6.8 or a later stable OpenClaw CalVer.",
      changelogError,
      errors.appcast,
      "rollback drill is older than 90 days: 2026-03-01. Run the private rollback drill before stable closeout.",
    ],
    [
      "prerelease main",
      { mainPackageJson: { version: "2026.6.9-beta.1" } },
      "main package.json version is 2026.6.9-beta.1, expected shipped version 2026.6.8 or a later stable OpenClaw CalVer.",
    ],
  ])("rejects %s", (_name, params, ...expectedErrors) => {
    rejects(params, ...expectedErrors);
  });

  it("writes identical closeout evidence when replayed", () => {
    const first = verify();
    const replay = verify({
      release: {
        ...release,
        assets: [
          ...release.assets,
          ...["d", "e"].map((digit, index) => ({
            name: `openclaw-2026.6.8-stable-main-closeout.json${index === 0 ? "" : ".sha256"}`,
            digest: `sha256:${digit.repeat(64)}`,
          })),
        ],
      },
      nowMs: Date.parse("2026-06-18T00:00:00Z"),
    });

    expect(replay.manifest).toEqual(first.manifest);
  });

  it("replays unchanged omitted-digest input using its recorded rollback drill", () => {
    const releaseWithMissingDigest = {
      ...release,
      assets: release.assets.map((asset, index) => (index === 0 ? { name: asset.name } : asset)),
    };
    const first = succeeds({ release: releaseWithMissingDigest });
    const replay = succeeds({
      release: releaseWithMissingDigest,
      existingManifest: first,
      publishedAppcast: "<rss>newer app release without the old entry</rss>",
      allowStaleRollbackDrill: true,
      nowMs: Date.parse("2026-10-01T00:00:00Z"),
    });

    expect(first?.githubReleaseAssets[0]).toEqual({
      name: "OpenClaw-2026.6.8.zip",
      digest: null,
    });
    expect(replay).toEqual(first);
  });

  it.each(shippedReplayFixtures)("replays $label byte-for-byte", ({ manifest, params }) => {
    expectReplay(
      {
        ...params,
        mainAppcast: "<rss>current feed without the historical release</rss>",
      },
      manifest,
    );
  });

  it("rejects replay with a noncanonical recorded appcast hash", () => {
    const { manifest, params } = shippedSeptemberReplayFixture;
    rejects(
      { ...params, existingManifest: { ...manifest, appcastSha256: "f".repeat(63) } },
      appcastEvidenceError,
    );
  });

  describe("withdrawn macOS appcast", () => {
    const version = thinVersion;
    const tag = thinTag;
    const withdrawal = { commit: "a".repeat(40), reason: "Refs #156861" };
    const olderFeed =
      "<rss><sparkle:shortVersionString>2026.9.5</sparkle:shortVersionString></rss>";
    const params = {
      ...thinCloseoutParams,
      mainAppcast: olderFeed,
      rollbackDrillDate: "2026-09-01",
      nowMs: Date.parse("2026-09-23T00:00:00Z"),
    };
    const marker = {
      sha: withdrawal.commit,
      commit: {
        message: `chore(release): withdraw the ${version} macOS build from the Sparkle feed\n\nRestore the 2026.9.5 feed.\n\nRefs #156861\n`,
      },
    };

    it("finds only the exact marker commit and records its first Refs line", () => {
      const update = {
        sha: "b".repeat(40),
        commit: { message: `chore(release): update appcast for ${version} (#156852)` },
      };
      expect(findAppcastWithdrawal([update, marker], version)).toEqual(withdrawal);
      expect(findAppcastWithdrawal([marker], "2026.9.5")).toBeUndefined();
      expect(
        findAppcastWithdrawal(
          [{ ...marker, commit: { message: marker.commit.message.split("\n")[0] } }],
          version,
        ),
      ).toEqual({ commit: withdrawal.commit, reason: marker.commit.message.split("\n")[0] });
    });

    it.each([
      ["without a marker commit", olderFeed, undefined],
      ["when the newest entry is not older", olderFeed.replace("2026.9.5", version), withdrawal],
    ])("keeps a plain appcast mismatch failing %s", (_label, mainAppcast, found) => {
      const result = verifyStableMainCloseout({
        ...params,
        mainAppcast,
        findAppcastWithdrawal: () => found,
      });

      expect(result.errors).toEqual([
        `main appcast.xml does not point at OpenClaw-${version}.zip from ${tag}.`,
      ]);
      expect(result.manifest).toBeNull();
    });

    it("replays a withdrawn receipt byte-for-byte without another lookup", () => {
      const lookups: string[] = [];
      const first = succeeds({
        ...params,
        findAppcastWithdrawal: (requested: string) => {
          lookups.push(requested);
          return withdrawal;
        },
      });
      expect(lookups).toEqual([version]);
      expect(first).toMatchObject({
        apps: "pending",
        appPlatforms: { macos: "withdrawn", android: "pending", windows: "pending" },
        appcast: "withdrawn",
        appcastWithdrawal: withdrawal,
      });
      expect(first).not.toHaveProperty("appcastSha256");
      const replayParams = {
        ...params,
        existingManifest: first,
        publishedAppcast:
          "<rss><sparkle:shortVersionString>2026.9.7</sparkle:shortVersionString></rss>",
        findAppcastWithdrawal: () => {
          throw new Error("replay must not look up the withdrawal again");
        },
      };
      expectReplay(replayParams, first);
      rejects(
        {
          ...replayParams,
          existingManifest: { ...first, appcastWithdrawal: { commit: "main" } },
        },
        appcastEvidenceError,
      );
      rejects(
        {
          ...replayParams,
          existingManifest: {
            ...first,
            appPlatforms: { ...first?.appPlatforms, macos: "attached" },
          },
        },
        errors.platform,
      );
    });

    it("preserves a pending receipt when macOS attaches and is then withdrawn", () => {
      const pending = verifyStableMainCloseout({
        ...params,
        release: { ...params.release, assets: [] },
      });
      expect(pending.manifest).toMatchObject({ appcast: "pending" });
      expectReplay(
        {
          ...params,
          existingManifest: pending.manifest,
          publishedAppcast: olderFeed,
          findAppcastWithdrawal: () => withdrawal,
        },
        pending.manifest,
      );
    });
  });

  it.each([
    ["OpenClaw-2026.6.8.zip", null, "macos", "pending"],
    ["OpenClaw-Android.apk", `sha256:${"D".repeat(64)}`, "android", "verified"],
    ["OpenClawCompanion-Setup-x64.exe", `sha256:${"d".repeat(63)}`, "windows", "verified"],
    ["OpenClawCompanion-SHA256SUMS.txt", `sha256:${"d".repeat(64)}\n`, "windows", "verified"],
  ])("keeps noncanonical %s evidence pending", (assetName, digest, platform, appcast) => {
    const assets = completeAppAssets.map((asset) =>
      asset.name === assetName ? { name: asset.name, digest } : asset,
    );
    expect(succeeds({ release: { ...release, assets } })).toMatchObject({
      apps: "pending",
      appPlatforms: { [platform]: "pending" },
      appcast,
    });
  });

  it("rejects replay when recorded attached state lacks canonical digests", () => {
    const first = verify({ release: { ...release, assets: completeAppAssets } });
    const invalidAssets = completeAppAssets.map((asset) =>
      asset.name === "OpenClaw-Android.apk"
        ? { name: asset.name, digest: asset.digest.toUpperCase() }
        : asset,
    );
    rejects(
      {
        release: { ...release, assets: invalidAssets },
        existingManifest: {
          ...first.manifest,
          githubReleaseAssets: invalidAssets,
        },
      },
      errors.platform,
      "Recorded aggregate app state does not match canonical release asset digests.",
    );
  });

  it("records the independently verified split attempts and refuses missing or changed replay proof", () => {
    const publishRecovery = {
      npmDockerVerified: true,
      mode: "split-publication-v1",
      releaseTag: "v2026.6.8",
      sourceSha: "tag-sha",
      toolingSha: "a".repeat(40),
      fullReleaseValidation: { runId: "11", runAttempt: "2" },
      originalParent: { runId: "12", runAttempt: "3", conclusion: "failure" },
      npm: { runId: "13", runAttempt: "1", jobId: "130" },
      docker: { runId: "14", runAttempt: "1", jobId: "140" },
    };
    const params = {
      ...validCloseoutParams,
      allowFailedPublishRecovery: true,
      publishRecovery,
    };
    const first = succeeds(params);
    expect(first?.releasePublishRecovery).toEqual(publishRecovery);
    const replay = { ...params, existingManifest: first };
    expect(verify(replay).manifest).toEqual(first);
    for (const replacement of [
      undefined,
      { ...publishRecovery, docker: { ...publishRecovery.docker, runAttempt: "2" } },
    ]) {
      rejects({ ...replay, publishRecovery: replacement });
    }
    for (const patch of [
      { allowFailedPublishRecovery: false },
      { releaseTagSha: "another-sha" },
      { tag: "v2026.6.8-2", release: { ...release, tagName: "v2026.6.8-2" } },
      { fullReleaseValidationRunAttempt: "3" },
      { releasePublishRunId: "15" },
    ]) {
      rejects({ ...params, ...patch });
    }
  });

  it("allows mirrored prose changes only with unchanged frozen release accounting", () => {
    const section = extractStableChangelogSection(changelog, "2026.6.8");
    const record =
      "## 2026.6.8\n\n### Complete contribution record\n\n- Shipped fix. (#123) Thanks @author.\n";
    const params = {
      ...validCloseoutParams,
      mainRelease: {
        section: "## 2026.6.8\n\nClearer published documentation.\n",
        format: "docs-mirror",
        record,
      },
      tagRelease: { section, format: "initial", record },
    };
    expect(succeeds(params)?.changelogSha256).toBe(sha256(section!));
    for (const changedRecord of [null, "Changed accounting"]) {
      rejects(
        {
          ...params,
          mainRelease: { ...params.mainRelease, record: changedRecord },
        },
        errors.accounting,
      );
    }
    rejects(
      {
        ...params,
        mainRelease: { ...params.mainRelease, format: "initial" },
      },
      changelogError,
    );
  });
});
