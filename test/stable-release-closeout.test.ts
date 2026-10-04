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
  tag: thinTag,
  mainPackageJson: { version: thinVersion },
  tagPackageJson: { version: thinVersion },
  mainChangelog: thinChangelog,
  tagChangelog: thinChangelog,
  release: {
    tagName: thinTag,
    isDraft: false,
    isPrerelease: false,
    assets: ["", "-arm64", "-x86_64"]
      .flatMap((suffix) =>
        ["zip", "dmg", "dSYM.zip"].map(
          (extension) => `OpenClaw-${thinVersion}${suffix}.${extension}`,
        ),
      )
      .map((name, index) => ({ name, digest: `sha256:${index.toString(16).repeat(64)}` })),
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
  const githubReleaseAssets = [
    `OpenClaw-${version}.zip`,
    `OpenClaw-${version}.dmg`,
    `OpenClaw-${version}.dSYM.zip`,
    ...(complete ? remainingAppAssets : []),
  ].map((name, index) => ({
    name,
    digest: `sha256:${index.toString(16).repeat(64)}`,
  }));
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
      tag,
      mainPackageJson: { version: mainVersion },
      tagPackageJson: { version },
      mainChangelog: replayChangelog,
      tagChangelog: replayChangelog,
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
const shippedReplayFixtures: Array<
  ReturnType<typeof shippedReplayFixture> & { assetNames?: string[] }
> = [
  shippedJulyReplayFixture,
  shippedSeptemberReplayFixture,
  {
    ...shippedReplayFixture("2026.9.5", "2026.9.6", false),
    assetNames: ["OpenClaw-2026.9.5.zip", "OpenClaw-2026.9.5.dmg", "OpenClaw-2026.9.5.dSYM.zip"],
  },
];

describe("stable release closeout", () => {
  it("parses stable and correction tags", () => {
    expect(parseStableReleaseTag("v2026.6.8")).toBe("2026.6.8");
    expect(parseStableReleaseTag("v2026.6.8-2")).toBe("2026.6.8");
    expect(() => parseStableReleaseTag("v2026.6.8-0")).toThrow("expected a stable release tag");
    expect(() => parseStableReleaseTag("v2026.6.8-beta.1")).toThrow(
      "expected a stable release tag",
    );
  });

  it.each<{
    name: string;
    params: CloseoutOverrides;
    manifest: Record<string, unknown>;
    absent?: string;
  }>([
    {
      name: "an exact stable closeout with a current rollback drill",
      params: {},
      manifest: {
        version: 2,
        releaseTag: "v2026.6.8",
        releaseVersion: "2026.6.8",
        fullReleaseValidationRunAttempt: "2",
        rollbackDrill: { id: "rollback-drill-2026-q2", date: "2026-06-01" },
      },
      absent: "verifiedAt",
    },
    {
      name: "main advancing to a later stable CalVer",
      params: { mainPackageJson: { version: "2026.7.1" } },
      manifest: {
        releaseVersion: "2026.6.8",
        mainPackageVersion: "2026.7.1",
        releaseTagPackageVersion: "2026.6.8",
      },
    },
    {
      name: "pending apps and appcast before app publication",
      params: {
        release: { ...release, assets: [] },
        mainAppcast: "https://example.test/old.zip\n",
      },
      manifest: { apps: "pending", appcast: "pending" },
      absent: "appcastSha256",
    },
    {
      name: "exact correction versions for release state and assets",
      params: {
        tag: "v2026.6.8-2",
        mainPackageJson: { version: "2026.6.8-2" },
        tagPackageJson: { version: "2026.6.8-2" },
        mainChangelog: changelog.replaceAll("2026.6.8", "2026.6.8-2"),
        tagChangelog: changelog.replaceAll("2026.6.8", "2026.6.8-2"),
        release: {
          ...release,
          tagName: "v2026.6.8-2",
          assets: release.assets.map((asset) => ({
            ...asset,
            name: asset.name.replaceAll("2026.6.8", "2026.6.8-2"),
          })),
        },
        mainAppcast:
          "https://github.com/openclaw/openclaw/releases/download/v2026.6.8-2/OpenClaw-2026.6.8-2.zip\n",
      },
      manifest: {
        releaseVersion: "2026.6.8-2",
        mainPackageVersion: "2026.6.8-2",
        releaseTagPackageVersion: "2026.6.8-2",
      },
    },
    {
      name: "a fallback correction tag for an existing base stable package",
      params: {
        tag: "v2026.6.8-2",
        mainPackageJson: { version: "2026.6.9" },
        release: { ...release, tagName: "v2026.6.8-2" },
        mainAppcast:
          "https://github.com/openclaw/openclaw/releases/download/v2026.6.8-2/OpenClaw-2026.6.8.zip\n",
      },
      manifest: {
        releaseVersion: "2026.6.8",
        mainPackageVersion: "2026.6.9",
        releaseTagPackageVersion: "2026.6.8",
      },
    },
    {
      name: "attached apps when every app family has published",
      params: { release: { ...release, assets: completeAppAssets } },
      manifest: { apps: "attached", appcast: "verified" },
    },
  ])("records $name", ({ params, manifest, absent }) => {
    const result = verifyStableMainCloseout({ ...validCloseoutParams, ...params });
    expect(result.errors).toEqual([]);
    expect(result.manifest).toMatchObject(manifest);
    if (absent) {
      expect(result.manifest).not.toHaveProperty(absent);
    }
  });

  it.each<{ name: string; params: CloseoutOverrides; errors: string[] }>([
    {
      name: "a missing exact Full Release Validation run attempt",
      params: { fullReleaseValidationRunAttempt: "" },
      errors: ["full release validation run attempt is invalid: <missing>."],
    },
    {
      name: "a stale architecture-specific feed from 2026.9.6",
      params: {
        ...thinCloseoutParams,
        mainX86_64Appcast: "<rss>stale Intel feed</rss>",
        nowMs: Date.parse("2026-09-21T00:00:00Z"),
      },
      errors: [
        `main appcast-x86_64.xml does not point at OpenClaw-${thinVersion}-x86_64.zip from ${thinTag}.`,
      ],
    },
    {
      name: "a stale main appcast snapshot despite a valid published feed",
      params: {
        mainAppcast: "<rss>stale main feed</rss>",
        publishedAppcast:
          "https://github.com/openclaw/openclaw/releases/download/v2026.6.8/OpenClaw-2026.6.8.zip",
      },
      errors: ["main appcast.xml does not point at OpenClaw-2026.6.8.zip from v2026.6.8."],
    },
    {
      name: "calendar-normalized rollback drill dates",
      params: { rollbackDrillDate: "2026-02-31" },
      errors: ["rollback drill date is invalid: 2026-02-31."],
    },
    {
      name: "older main state, appcast drift, and stale rollback drills",
      params: {
        mainPackageJson: { version: "2026.6.7" },
        mainChangelog: changelog.replace("Shipped fix.", "Different fix."),
        mainAppcast: "https://example.test/old.zip\n",
        rollbackDrillId: "rollback-drill-2026-q1",
        rollbackDrillDate: "2026-03-01",
      },
      errors: [
        "main package.json version is 2026.6.7, expected shipped version 2026.6.8 or a later stable OpenClaw CalVer.",
        "main CHANGELOG.md ## 2026.6.8 does not exactly match the shipped release section.",
        "main appcast.xml does not point at OpenClaw-2026.6.8.zip from v2026.6.8.",
        "rollback drill is older than 90 days: 2026-03-01. Run the private rollback drill before stable closeout.",
      ],
    },
    {
      name: "prerelease main state",
      params: { mainPackageJson: { version: "2026.6.9-beta.1" } },
      errors: [
        "main package.json version is 2026.6.9-beta.1, expected shipped version 2026.6.8 or a later stable OpenClaw CalVer.",
      ],
    },
  ])("rejects $name", ({ params, errors }) => {
    const result = verifyStableMainCloseout({ ...validCloseoutParams, ...params });
    for (const error of errors) {
      expect(result.errors).toContain(error);
    }
    expect(result.manifest).toBeNull();
  });

  it("writes identical closeout evidence when replayed", () => {
    const first = verifyStableMainCloseout({
      ...validCloseoutParams,
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

  it("replays unchanged omitted-digest input using its recorded rollback drill", () => {
    const releaseWithMissingDigest = {
      ...release,
      assets: release.assets.map((asset, index) => (index === 0 ? { name: asset.name } : asset)),
    };
    const first = verifyStableMainCloseout({
      ...validCloseoutParams,
      release: releaseWithMissingDigest,
    });
    const replay = verifyStableMainCloseout({
      ...validCloseoutParams,
      release: releaseWithMissingDigest,
      existingManifest: first.manifest,
      publishedAppcast: "<rss>newer app release without the old entry</rss>",
      allowStaleRollbackDrill: true,
      nowMs: Date.parse("2026-10-01T00:00:00Z"),
    });

    expect(first.manifest?.githubReleaseAssets[0]).toEqual({
      name: "OpenClaw-2026.6.8.zip",
      digest: null,
    });
    expect(replay.errors).toEqual([]);
    expect(replay.manifest).toEqual(first.manifest);
  });

  it.each(shippedReplayFixtures)(
    "replays $label byte-for-byte",
    ({ manifest, params, assetNames }) => {
      const serializedReceipt = JSON.stringify(manifest);
      const result = verifyStableMainCloseout({
        ...params,
        mainAppcast: "<rss>current feed without the historical release</rss>",
      });
      expect(result.errors).toEqual([]);
      expect(JSON.stringify(result.manifest)).toBe(serializedReceipt);
      if (assetNames) {
        expect(
          result.manifest?.githubReleaseAssets.map((asset: { name: string }) => asset.name),
        ).toEqual(assetNames);
      }
    },
  );

  it("rejects replay with a noncanonical recorded appcast hash", () => {
    const { manifest, params } = shippedSeptemberReplayFixture;
    const result = verifyStableMainCloseout({
      ...params,
      existingManifest: { ...manifest, appcastSha256: "f".repeat(63) },
    });

    expect(result.errors).toContain(
      "Recorded appcast evidence presence or format does not match canonical macOS release asset state.",
    );
    expect(result.manifest).toBeNull();
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

    it("records the withdrawal instead of the feed link contracts", () => {
      const lookups: string[] = [];
      const result = verifyStableMainCloseout({
        ...params,
        findAppcastWithdrawal: (requested: string) => {
          lookups.push(requested);
          return withdrawal;
        },
      });

      expect(result.errors).toEqual([]);
      expect(lookups).toEqual([version]);
      expect(result.manifest).toMatchObject({
        apps: "pending",
        appPlatforms: { macos: "withdrawn", android: "pending", windows: "pending" },
        appcast: "withdrawn",
        appcastWithdrawal: withdrawal,
      });
      expect(result.manifest).not.toHaveProperty("appcastSha256");
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
      const first = verifyStableMainCloseout({
        ...params,
        findAppcastWithdrawal: () => withdrawal,
      });
      const replayParams = {
        ...params,
        existingManifest: first.manifest,
        publishedAppcast:
          "<rss><sparkle:shortVersionString>2026.9.7</sparkle:shortVersionString></rss>",
        findAppcastWithdrawal: () => {
          throw new Error("replay must not look up the withdrawal again");
        },
      };
      const replay = verifyStableMainCloseout(replayParams);

      expect(replay.errors).toEqual([]);
      expect(JSON.stringify(replay.manifest)).toBe(JSON.stringify(first.manifest));
      expect(
        verifyStableMainCloseout({
          ...replayParams,
          existingManifest: { ...first.manifest, appcastWithdrawal: { commit: "main" } },
        }).errors,
      ).toContain(
        "Recorded appcast evidence presence or format does not match canonical macOS release asset state.",
      );
      expect(
        verifyStableMainCloseout({
          ...replayParams,
          existingManifest: {
            ...first.manifest,
            appPlatforms: { ...first.manifest?.appPlatforms, macos: "attached" },
          },
        }).errors,
      ).toContain("Recorded app platform states do not match canonical release asset digests.");
    });

    it("preserves a pending receipt when macOS attaches and is then withdrawn", () => {
      const pending = verifyStableMainCloseout({
        ...params,
        release: { ...params.release, assets: [] },
      });
      const replay = verifyStableMainCloseout({
        ...params,
        existingManifest: pending.manifest,
        publishedAppcast: olderFeed,
        findAppcastWithdrawal: () => withdrawal,
      });

      expect(pending.manifest).toMatchObject({ appcast: "pending" });
      expect(replay.errors).toEqual([]);
      expect(JSON.stringify(replay.manifest)).toBe(JSON.stringify(pending.manifest));
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
    const result = verifyStableMainCloseout({
      ...validCloseoutParams,
      release: { ...release, assets },
    });

    expect(result.errors).toEqual([]);
    expect(result.manifest).toMatchObject({
      apps: "pending",
      appPlatforms: { [platform]: "pending" },
      appcast,
    });
  });

  it("rejects replay when recorded attached state lacks canonical digests", () => {
    const assets = completeAppAssets;
    const first = verifyStableMainCloseout({
      ...validCloseoutParams,
      release: { ...release, assets },
    });
    const invalidAssets = assets.map((asset) =>
      asset.name === "OpenClaw-Android.apk"
        ? { name: asset.name, digest: asset.digest.toUpperCase() }
        : asset,
    );
    const replay = verifyStableMainCloseout({
      ...validCloseoutParams,
      release: { ...release, assets: invalidAssets },
      existingManifest: {
        ...first.manifest,
        githubReleaseAssets: invalidAssets,
      },
    });

    expect(replay.errors).toContain(
      "Recorded app platform states do not match canonical release asset digests.",
    );
    expect(replay.errors).toContain(
      "Recorded aggregate app state does not match canonical release asset digests.",
    );
    expect(replay.manifest).toBeNull();
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
    const first = verifyStableMainCloseout(params);
    expect(first.errors).toEqual([]);
    expect(first.manifest?.releasePublishRecovery).toEqual(publishRecovery);
    const replay = { ...params, existingManifest: first.manifest };
    expect(verifyStableMainCloseout(replay).manifest).toEqual(first.manifest);
    for (const replacement of [
      undefined,
      { ...publishRecovery, docker: { ...publishRecovery.docker, runAttempt: "2" } },
    ]) {
      expect(
        verifyStableMainCloseout({ ...replay, publishRecovery: replacement }).manifest,
      ).toBeNull();
    }
    for (const patch of [
      { allowFailedPublishRecovery: false },
      { releaseTagSha: "another-sha" },
      { tag: "v2026.6.8-2", release: { ...release, tagName: "v2026.6.8-2" } },
      { fullReleaseValidationRunAttempt: "3" },
      { releasePublishRunId: "15" },
    ]) {
      expect(verifyStableMainCloseout({ ...params, ...patch }).manifest).toBeNull();
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
    const result = verifyStableMainCloseout(params);
    expect(result.errors).toEqual([]);
    expect(result.manifest?.changelogSha256).toBe(sha256(section!));
    for (const changedRecord of [null, "Changed accounting"]) {
      expect(
        verifyStableMainCloseout({
          ...params,
          mainRelease: { ...params.mainRelease, record: changedRecord },
        }).errors,
      ).toContain(
        "main changelog 2026.6.8 frozen contribution record does not match the shipped release accounting.",
      );
    }
    expect(
      verifyStableMainCloseout({
        ...params,
        mainRelease: { ...params.mainRelease, format: "initial" },
      }).errors,
    ).toContain(
      "main CHANGELOG.md ## 2026.6.8 does not exactly match the shipped release section.",
    );
  });
});
