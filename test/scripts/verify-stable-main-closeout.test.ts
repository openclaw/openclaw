// Verify Stable Main Closeout tests cover stable closeout CLI behavior.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  readRecoveryStepInputs,
  requireRecoveryJob,
  validateRecoveryProvenance,
  validateRecoveryRun,
  verifyStablePublishRecovery,
} from "../../scripts/lib/stable-publish-recovery.mjs";
import { verifyStableMainCloseout } from "../../scripts/lib/stable-release-closeout.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const linuxTempDirs = useAutoCleanupTempDirTracker(afterEach);

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runCli(...args: string[]) {
  return spawnSync(process.execPath, ["scripts/verify-stable-main-closeout.mjs", ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });
}

type LinuxAsset = {
  name: string;
  digest: string;
  state: string;
  size: number;
  bytes?: string;
  id?: number;
};
const linuxRepository = "openclaw/openclaw";

function linuxAsset(name: string, bytes: string): LinuxAsset {
  return {
    name,
    bytes,
    size: Buffer.byteLength(bytes),
    state: "uploaded",
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

function linuxPublication(version: string) {
  const appimage = `OpenClaw-${version}-amd64.AppImage`;
  const deb = `OpenClaw-${version}-amd64.deb`;
  const selector = linuxAsset(
    "latest.json",
    JSON.stringify({
      version,
      platforms: {
        "linux-x86_64": {
          signature: Buffer.from("signed Linux AppImage").toString("base64"),
          url: `https://github.com/${linuxRepository}/releases/download/v${version}/${appimage}`,
        },
      },
    }),
  );
  const assets: LinuxAsset[] = [
    { name: appimage, digest: `sha256:${"1".repeat(64)}`, state: "uploaded", size: 100, id: 101 },
    { name: deb, digest: `sha256:${"2".repeat(64)}`, state: "uploaded", size: 100, id: 102 },
    {
      ...linuxAsset(
        "SHA256SUMS.linux-app.txt",
        `${"1".repeat(64)}  ./${appimage}\n${"2".repeat(64)}  ./${deb}\n`,
      ),
      id: 103,
    },
    selector,
  ];
  return {
    databaseId: 42,
    tagName: `v${version}`,
    isDraft: false,
    isPrerelease: false,
    assets,
  };
}

function linuxCloseoutFixture(carried = false, tag = "v2026.9.4") {
  const dir = linuxTempDirs.make("openclaw-linux-closeout-");
  const version = tag.slice(1);
  const packageVersion = version.replace(/-[1-9]\d*$/u, "");
  const changelog = `# Changelog\n\n## ${packageVersion}\n\n- Released.\n`;
  const date = new Date().toISOString().slice(0, 10);
  const baseParams = {
    tag,
    mainPackageJson: { version: packageVersion },
    tagPackageJson: { version: packageVersion },
    mainChangelog: changelog,
    tagChangelog: changelog,
    mainAppcast: "<rss>older app release</rss>",
    releaseTagSha: "a".repeat(40),
    mainSha: "a".repeat(40),
    fullReleaseValidationRunId: "11",
    fullReleaseValidationRunAttempt: "2",
    releasePublishRunId: "12",
    rollbackDrillId: "synthetic-drill",
    rollbackDrillDate: date,
    nowMs: Date.now(),
  };
  for (const name of ["main", "tag"]) {
    const root = path.join(dir, name);
    mkdirSync(root);
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: packageVersion }));
    writeFileSync(path.join(root, "CHANGELOG.md"), changelog);
    writeFileSync(path.join(root, "appcast.xml"), baseParams.mainAppcast);
  }
  const original = linuxPublication("2026.9.3");
  const evidence = linuxAsset(
    `openclaw-${version}-postpublish-evidence.json`,
    "immutable evidence",
  );
  const carrier = {
    databaseId: 42,
    tagName: tag,
    isDraft: false,
    isPrerelease: false,
    assets: [evidence],
  };
  if (carried) {
    carrier.assets.push(
      expectDefined(
        original.assets.find((asset) => asset.name === "latest.json"),
        "original Linux selector",
      ),
    );
  }
  const releasePath = path.join(dir, "release.json");
  const remotePath = path.join(dir, "remote.json");
  const outputPath = path.join(dir, "closeout.json");
  const originalPath = path.join(dir, "original.json");
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "git"),
    `#!/usr/bin/env node
if (process.argv[2] !== '-C' || process.argv[4] !== 'rev-parse') throw new Error('Unexpected git operation');
process.stdout.write('${"a".repeat(40)}\\n');
`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const releases = JSON.parse(fs.readFileSync(process.env.LINUX_CLOSEOUT_REMOTE, 'utf8'));
if (args[0] === 'api' && args[1]?.startsWith('repos/${linuxRepository}/commits/')) {
  process.stdout.write('${"a".repeat(40)}\\n');
  process.exit(0);
}
if (args[0] === 'api' && args[1]?.startsWith('repos/${linuxRepository}/releases/tags/')) {
  const tag = args[1].slice('repos/${linuxRepository}/releases/tags/'.length);
  const release = releases[tag];
  if (!release) throw new Error('Missing release');
  process.stdout.write(JSON.stringify({id: release.databaseId, tag_name: tag,
    draft: release.isDraft, prerelease: release.isPrerelease,
    assets: release.assets.map(({bytes, ...asset}) => asset)}));
  process.exit(0);
}
const release = releases[args[2]];
if (args[0] !== 'release' || !release) throw new Error('Unexpected GitHub operation');
if (args[1] === 'view') {
  if (args[args.indexOf('--json') + 1].includes('databaseId')) throw new Error('Unknown JSON field: databaseId');
  process.stdout.write(JSON.stringify({...release, assets: release.assets.map(({bytes, ...asset}) => asset)}));
} else if (args[1] === 'download') {
  const name = args[args.indexOf('--pattern') + 1];
  if (!['latest.json', 'SHA256SUMS.linux-app.txt', 'OpenClaw-' + args[2].slice(1) + '-linux.json'].includes(name)) throw new Error('Binary download forbidden');
  const asset = release.assets.find(asset => asset.name === name);
  if (!asset || typeof asset.bytes !== 'string') throw new Error('Missing asset');
  process.stdout.write(asset.bytes);
} else throw new Error('GitHub writes forbidden');
`,
    { mode: 0o755 },
  );
  const metadata = () => ({
    ...carrier,
    assets: carrier.assets.map(({ bytes: _bytes, ...asset }) => asset),
  });
  const args = [
    "--tag",
    tag,
    "--main-dir",
    path.join(dir, "main"),
    "--tag-dir",
    path.join(dir, "tag"),
    "--release-json",
    releasePath,
    "--full-release-validation-run-id",
    "11",
    "--full-release-validation-run-attempt",
    "2",
    "--release-publish-run-id",
    "12",
    "--rollback-drill-id",
    "synthetic-drill",
    "--rollback-drill-date",
    date,
    "--output",
    outputPath,
  ];
  return {
    carrier,
    evidence,
    originalPath,
    outputPath,
    publishLinux() {
      carrier.assets = [evidence, ...linuxPublication(version).assets];
    },
    publishImmutable() {
      const publication = linuxPublication(version);
      const selector = expectDefined(
        publication.assets.find((asset) => asset.name === "latest.json"),
        "selector",
      );
      const value = JSON.parse(expectDefined(selector.bytes, "selector bytes"));
      value.linuxPublication = {
        schemaVersion: 1,
        sourceSha: "a".repeat(40),
        toolingSha: "b".repeat(40),
        channelSha: "c".repeat(40),
        releaseId: 42,
        publicKeySha256: "d".repeat(64),
        assets: publication.assets
          .filter((asset) => asset.name !== "latest.json")
          .map((asset) => ({
            id: asset.id,
            name: asset.name,
            size: asset.size,
            sha256: asset.digest.slice(7),
          })),
      };
      carrier.assets.push(linuxAsset(`OpenClaw-${version}-linux.json`, JSON.stringify(value)));
    },
    params() {
      return { ...baseParams, release: metadata() };
    },
    run(replay = false) {
      writeFileSync(releasePath, JSON.stringify(metadata()));
      writeFileSync(remotePath, JSON.stringify({ [original.tagName]: original, [tag]: carrier }));
      return spawnSync(
        process.execPath,
        [
          "scripts/verify-stable-main-closeout.mjs",
          ...args,
          ...(replay ? ["--existing-manifest", originalPath] : []),
        ],
        {
          cwd: path.resolve("."),
          encoding: "utf8",
          timeout: 20_000,
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            GITHUB_REPOSITORY: linuxRepository,
            LINUX_CLOSEOUT_REMOTE: remotePath,
          },
        },
      );
    },
  };
}

describe("stable closeout Linux publication", () => {
  it("accepts only the validated exact late immutable Linux manifest", () => {
    const fixture = linuxCloseoutFixture();
    expect(fixture.run().status).toBe(0);
    const original = readFileSync(fixture.outputPath);
    writeFileSync(fixture.originalPath, original);
    fixture.publishLinux();
    fixture.publishImmutable();
    const replay = fixture.run(true);
    expect(replay.status, replay.stderr).toBe(0);
    expect(readFileSync(fixture.outputPath)).toEqual(original);
    const immutable = expectDefined(
      fixture.carrier.assets.find((asset) => asset.name.endsWith("-linux.json")),
      "immutable manifest",
    );
    immutable.digest = `sha256:${"f".repeat(64)}`;
    expect(fixture.run(true).status).toBe(1);
  });

  it.each([
    { carried: false, tag: "v2026.9.4" },
    { carried: true, tag: "v2026.9.4" },
    { carried: true, tag: "v2026.9.4-1" },
  ])(
    "preserves receipt bytes after late Linux assets and selector (carried=$carried, $tag)",
    ({ carried, tag }) => {
      const fixture = linuxCloseoutFixture(carried, tag);
      const initial = fixture.run();
      expect(initial.status, initial.stderr).toBe(0);
      const bytes = readFileSync(fixture.outputPath, "utf8");
      writeFileSync(fixture.originalPath, bytes);
      expect(JSON.parse(bytes).appPlatforms).toEqual({
        macos: "pending",
        android: "pending",
        windows: "pending",
      });
      fixture.publishLinux();
      const replay = fixture.run(true);
      expect(replay.status, replay.stderr).toBe(0);
      expect(readFileSync(fixture.outputPath, "utf8")).toBe(bytes);
      fixture.evidence.digest = `sha256:${"d".repeat(64)}`;
      const changed = fixture.run(true);
      expect(changed.status).toBe(1);
      expect(changed.stderr).toContain(
        `Recorded release asset changed or disappeared: ${fixture.evidence.name}`,
      );
    },
  );

  it("does not treat recorded Linux bundles as mutable updater selectors", () => {
    const fixture = linuxCloseoutFixture();
    fixture.publishLinux();
    const initial = fixture.run();
    expect(initial.status, initial.stderr).toBe(0);
    writeFileSync(fixture.originalPath, readFileSync(fixture.outputPath));
    const bundle = expectDefined(
      fixture.carrier.assets.find((asset) => asset.name.endsWith(".AppImage")),
      "published AppImage",
    );
    bundle.digest = `sha256:${"d".repeat(64)}`;
    const replay = fixture.run(true);
    expect(replay.status).toBe(1);
    expect(replay.stderr).toContain(
      `Recorded release asset changed or disappeared: ${bundle.name}`,
    );
  });

  it("requires source checksum proof and a matching current selector digest", () => {
    const fixture = linuxCloseoutFixture();
    const initial = fixture.run();
    expect(initial.status, initial.stderr).toBe(0);
    writeFileSync(fixture.originalPath, readFileSync(fixture.outputPath));
    fixture.publishLinux();
    const selector = expectDefined(
      fixture.carrier.assets.find((asset) => asset.name === "latest.json"),
      "current selector",
    );
    const digest = selector.digest;
    selector.digest = `sha256:${"d".repeat(64)}`;
    const wrongDigest = fixture.run(true);
    expect(wrongDigest.status).toBe(1);
    expect(wrongDigest.stderr).toContain("carrier asset digest");
    selector.digest = digest;
    fixture.carrier.assets = fixture.carrier.assets.filter(
      (asset) => asset.name !== "SHA256SUMS.linux-app.txt",
    );
    const missingChecksums = fixture.run(true);
    expect(missingChecksums.status).toBe(1);
    expect(missingChecksums.stderr).toContain("partial or inconsistent");
  });

  it("rejects missing or mismatched validated selector observations without rewriting a receipt", () => {
    const fixture = linuxCloseoutFixture();
    const initial = fixture.run();
    expect(initial.status, initial.stderr).toBe(0);
    const bytes = readFileSync(fixture.outputPath, "utf8");
    const existingManifest = JSON.parse(bytes);
    fixture.publishLinux();
    const selector = expectDefined(
      fixture.carrier.assets.find((asset) => asset.name === "latest.json"),
      "current selector",
    );
    const observation = {
      carrierTag: "v2026.9.4",
      manifestSha256: selector.digest.slice(7),
      sourceVersion: "2026.9.4",
    };
    for (const linuxUpdaterObservation of [
      undefined,
      { ...observation, carrierTag: "v2026.9.3" },
      { ...observation, manifestSha256: "d".repeat(64) },
      { ...observation, sourceVersion: "2026.9.5" },
      { ...observation, sourceVersion: undefined },
    ]) {
      const result = verifyStableMainCloseout({
        ...fixture.params(),
        existingManifest,
        linuxUpdaterObservation,
      });
      expect(result.manifest).toBeNull();
      expect(result.errors).toContain(
        "New or changed Linux updater selector requires a validated observation bound to this carrier and asset digest.",
      );
    }
    const verifiedReplay = verifyStableMainCloseout({
      ...fixture.params(),
      existingManifest,
      linuxUpdaterObservation: observation,
    });
    expect(verifiedReplay.errors).toEqual([]);
    expect(`${JSON.stringify(verifiedReplay.manifest, null, 2)}\n`).toBe(bytes);
  });
});

describe("verify-stable-main-closeout", () => {
  it("rejects option-shaped values before checking required arguments", () => {
    const result = runCli("--tag", "-h");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("--tag requires a value.");
  });

  it("closes npm releases with apps pending and preserves that snapshot after app attachment", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-closeout-"));
    tempDirs.push(dir);
    for (const name of ["main", "tag"]) {
      const root = path.join(dir, name);
      mkdirSync(root);
      execFileSync("git", ["init", "--quiet", root]);
      writeFileSync(path.join(root, ".git/HEAD"), `${"a".repeat(40)}\n`);
      writeFileSync(path.join(root, "package.json"), '{"version":"2026.6.8"}');
      writeFileSync(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## 2026.6.8\n\n- Released.\n");
      writeFileSync(path.join(root, "appcast.xml"), "<rss>older app release</rss>");
    }
    const releasePath = path.join(dir, "release.json");
    const outputPath = path.join(dir, "closeout.json");
    const originalPath = path.join(dir, "original.json");
    const evidence = {
      name: "openclaw-2026.6.8-postpublish-evidence.json",
      digest: `sha256:${"b".repeat(64)}`,
    };
    const release = {
      tagName: "v2026.6.8",
      isDraft: false,
      isPrerelease: false,
      assets: [evidence],
    };
    writeFileSync(releasePath, JSON.stringify(release));
    const args = [
      "--tag",
      "v2026.6.8",
      "--main-dir",
      path.join(dir, "main"),
      "--tag-dir",
      path.join(dir, "tag"),
      "--release-json",
      releasePath,
      "--full-release-validation-run-id",
      "11",
      "--full-release-validation-run-attempt",
      "2",
      "--release-publish-run-id",
      "12",
      "--rollback-drill-id",
      "synthetic-drill",
      "--rollback-drill-date",
      new Date().toISOString().slice(0, 10),
      "--output",
      outputPath,
      "--allow-failed-publish-recovery",
      "true",
    ];
    const initial = runCli(...args);
    expect(initial.status, initial.stderr).toBe(0);
    const initialBytes = readFileSync(outputPath, "utf8");
    expect(JSON.parse(initialBytes)).toMatchObject({
      apps: "pending",
      appcast: "pending",
      releasePublishRecovery: { npmDockerVerified: true },
    });
    writeFileSync(originalPath, initialBytes);
    mkdirSync(path.join(dir, "main", "CHANGELOG"));
    writeFileSync(
      path.join(dir, "main", "CHANGELOG.md"),
      "# Changelog\n\n<!-- openclaw:split-changelog -->\n",
    );
    writeFileSync(
      path.join(dir, "main", "CHANGELOG", "2026.6.8.md"),
      "## 2026.6.8\n\n- Released.\n",
    );
    const splitReplay = runCli(...args, "--existing-manifest", originalPath);
    expect(splitReplay.status, splitReplay.stderr).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toBe(initialBytes);
    release.assets.push(
      ...[
        "OpenClaw-2026.6.8.zip",
        "OpenClaw-2026.6.8.dmg",
        "OpenClaw-2026.6.8.dSYM.zip",
        "OpenClaw-Android.apk",
        "OpenClaw-Android-SHA256SUMS.txt",
        "OpenClawCompanion-Setup-arm64.exe",
        "OpenClawCompanion-Setup-x64.exe",
        "OpenClawCompanion-SHA256SUMS.txt",
      ].map((name) => ({ name, digest: `sha256:${"c".repeat(64)}` })),
    );
    writeFileSync(releasePath, JSON.stringify(release));
    const missingAppcast = runCli(...args, "--existing-manifest", originalPath);
    expect(missingAppcast.status).toBe(1);
    expect(missingAppcast.stderr).toContain(
      "main appcast.xml does not point at OpenClaw-2026.6.8.zip",
    );
    const publishedAppcastPath = path.join(dir, "published-appcast.xml");
    writeFileSync(
      publishedAppcastPath,
      "https://github.com/openclaw/openclaw/releases/download/v2026.6.8/OpenClaw-2026.6.8.zip",
    );
    const replay = runCli(
      ...args,
      "--existing-manifest",
      originalPath,
      "--published-appcast",
      publishedAppcastPath,
    );
    expect(replay.status, replay.stderr).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toBe(initialBytes);

    evidence.digest = `sha256:${"d".repeat(64)}`;
    writeFileSync(releasePath, JSON.stringify(release));
    const changed = runCli(...args, "--existing-manifest", originalPath);
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain(
      `Recorded release asset changed or disappeared: ${evidence.name}`,
    );
  });
});

describe("stable closeout workflow publication routing", () => {
  it.each([
    {
      name: "ordinary successful parent",
      manual: false,
      conclusion: "success",
      npm: "success",
      docker: "success",
      recovery: undefined,
      code: 0,
    },
    {
      name: "failed parent without manual recovery",
      manual: false,
      conclusion: "failure",
      npm: "success",
      docker: "success",
      recovery: undefined,
      code: 1,
    },
    {
      name: "legacy same-parent recovery",
      manual: true,
      conclusion: "failure",
      npm: "success",
      docker: "success",
      recovery: undefined,
      code: 0,
    },
    {
      name: "unrelated operator metadata",
      manual: true,
      conclusion: "failure",
      npm: "success",
      docker: "success",
      recovery: { reason: "App assets are pending" },
      code: 0,
    },
    {
      name: "failed legacy npm publication",
      manual: true,
      conclusion: "failure",
      npm: "failure",
      docker: "success",
      recovery: undefined,
      code: 1,
    },
    {
      name: "failed legacy Docker publication",
      manual: true,
      conclusion: "failure",
      npm: "success",
      docker: "failure",
      recovery: undefined,
      code: 1,
    },
    {
      name: "incomplete split selectors",
      manual: true,
      conclusion: "failure",
      npm: "success",
      docker: "success",
      recovery: { npmPublishRunId: "13" },
      code: 1,
    },
    {
      name: "rejects wrong-file checksum",
      manual: true,
      conclusion: "failure",
      npm: "success",
      docker: "success",
      recovery: undefined,
      code: 1,
      checksum: "wrong-file",
    },
    {
      name: "rejects duplicate checksum",
      manual: true,
      conclusion: "failure",
      npm: "success",
      docker: "success",
      recovery: undefined,
      code: 1,
      checksum: "duplicate",
    },
    {
      name: "rejects mismatch checksum",
      manual: true,
      conclusion: "failure",
      npm: "success",
      docker: "success",
      recovery: undefined,
      code: 1,
      checksum: "mismatch",
    },
  ])("preserves $name", (scenario) => {
    const workflow = readFileSync(".github/workflows/openclaw-stable-main-closeout.yml", "utf8");
    const block = workflow.match(
      /node --input-type=module - "\$RUNNER_TEMP\/release-publish-run.json"[^\n]+<<'NODE'\n([\s\S]*?)\n {10}NODE/u,
    )?.[1];
    if (!block) {
      throw new Error("Publication verifier node block missing");
    }
    const script = block
      .split("\n")
      .map((line) => line.slice(10))
      .join("\n")
      .replace(
        "'./.closeout-tooling/scripts/lib/stable-publish-recovery.mjs'",
        JSON.stringify(pathToFileURL(path.resolve("scripts/lib/stable-publish-recovery.mjs")).href),
      )
      .replace(
        '"./.closeout-tooling/scripts/lib/stable-release-closeout.mjs"',
        JSON.stringify(pathToFileURL(path.resolve("scripts/lib/stable-release-closeout.mjs")).href),
      );
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-closeout-routing-"));
    tempDirs.push(dir);
    const run = path.join(dir, "run.json");
    const evidence = path.join(dir, "evidence.json");
    const manifest = path.join(dir, "manifest.json");
    writeFileSync(
      run,
      JSON.stringify({
        workflowName: "OpenClaw Release Publish",
        event: "workflow_dispatch",
        status: "completed",
        conclusion: scenario.conclusion,
        jobs: [
          { name: "Publish plugins, then OpenClaw", conclusion: scenario.npm },
          {
            name: "Publish Docker images / Publish prepared Docker images",
            conclusion: scenario.docker,
          },
        ],
      }),
    );
    writeFileSync(
      evidence,
      JSON.stringify({
        releasePublishRunId: "12",
        releaseTag: "v2026.6.8",
        releaseVersion: "2026.6.8",
        releaseSha: "a".repeat(40),
        operatorRecovery: scenario.recovery,
      }),
    );
    writeFileSync(manifest, JSON.stringify({ targetSha: "a".repeat(40) }));
    let checksum = `${createHash("sha256").update(readFileSync(evidence)).digest("hex")}  evidence.json\n`;
    if ("checksum" in scenario) {
      if (scenario.checksum === "wrong-file") {
        checksum = `${createHash("sha256").update(readFileSync(manifest)).digest("hex")}  manifest.json\n`;
      }
      if (scenario.checksum === "duplicate") {
        checksum += checksum;
      }
      if (scenario.checksum === "mismatch") {
        checksum = `${"b".repeat(64)}  evidence.json\n`;
      }
    }
    writeFileSync(`${evidence}.sha256`, checksum);

    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-", run, manifest, evidence],
      {
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          ALLOW_FAILED_PUBLISH_RECOVERY: String(scenario.manual),
          RELEASE_PUBLISH_RUN_ID: "12",
          RELEASE_TAG: "v2026.6.8",
          SOURCE_SHA: "a".repeat(40),
          RUNNER_TEMP: dir,
        },
      },
    );
    expect(result.status, result.stderr).toBe(scenario.code);
    if ("checksum" in scenario) {
      expect(result.stderr).toContain("Release evidence checksum must bind exactly");
    }
    if (scenario.name === "incomplete split selectors") {
      expect(result.stderr).toContain("invalid run or attempt ID");
    }
  });
});

describe("stable closeout Full Release Validation checksum", () => {
  it.each(["valid", "wrong-file", "duplicate", "mismatch"])(
    "checks %s FRV manifest evidence",
    (kind) => {
      const dir = mkdtempSync(path.join(tmpdir(), "openclaw-frv-checksum-"));
      tempDirs.push(dir);
      const file = path.join(dir, "release-manifest.json");
      writeFileSync(
        file,
        JSON.stringify({ runId: "11", runAttempt: "2", targetSha: "a".repeat(40) }),
      );
      const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
      let checksum = `${digest}  release-manifest.json\n`;
      if (kind === "wrong-file") {
        checksum = `${digest}  another-file.json\n`;
      }
      if (kind === "duplicate") {
        checksum += checksum;
      }
      if (kind === "mismatch") {
        checksum = `${"b".repeat(64)}  release-manifest.json\n`;
      }
      writeFileSync(`${file}.sha256`, checksum);
      const result = runCli("verify-checksum", file);
      expect(result.status, result.stderr).toBe(kind === "valid" ? 0 : 1);
      if (kind !== "valid") {
        expect(result.stderr).toContain("Release evidence checksum must bind exactly");
      }
    },
  );
});

const sha = "a".repeat(40);
const workflow = ".github/workflows/openclaw-npm-release.yml";
const run = {
  id: 101,
  run_attempt: 2,
  head_sha: sha,
  path: workflow,
  event: "workflow_dispatch",
  status: "completed",
  conclusion: "success",
  repository: { full_name: "openclaw/openclaw" },
  head_repository: { full_name: "openclaw/openclaw" },
};
const expected = { id: "101", attempt: "2", sha, workflow, conclusion: "success" };
const job = {
  id: 201,
  name: "publish_openclaw_npm",
  run_id: 101,
  run_attempt: 2,
  head_sha: sha,
  status: "completed",
  conclusion: "success",
  steps: [{ name: "Publish", number: 4, status: "completed", conclusion: "success" }],
};
function log(lines: string[], step = "Publish", number = 4) {
  const bytes = Buffer.from(lines.map((line) => `2026-09-08T12:55:34.2712227Z ${line}`).join("\n"));
  return new Map([[`${job.name}/${number}_${step}.txt`, bytes]]);
}

const header = [
  "##[group]Run set -euo pipefail",
  "shell: /usr/bin/bash -e {0}",
  "env:",
  "  RELEASE_PUBLISH_RUN_ID: 100",
  "  RELEASE_PUBLISH_RUN_ATTEMPT: 3",
  "##[endgroup]",
];

describe("stable publication recovery boundaries", () => {
  it("rejects recovery for another tag even when both tags have the same source SHA", async () => {
    await expect(
      verifyStablePublishRecovery({
        evidence: { releaseTag: "v2026.9.3", releaseVersion: "2026.9.3", releaseSha: sha },
        manifest: { targetSha: sha },
        sourceSha: sha,
        tag: "v2026.9.3-2",
      }),
    ).rejects.toThrow("release source mismatch");
  });

  it("binds a successful npm child to its exact run, attempt, repository and workflow", () => {
    expect(validateRecoveryRun(run, expected)).toEqual(run);
    expect(requireRecoveryJob([job], run, job.name)).toEqual(job);
  });
  it.each([
    { id: 102 },
    { run_attempt: 3 },
    { head_sha: "b".repeat(40) },
    { path: ".github/workflows/other.yml" },
    { event: "pull_request" },
    { status: "in_progress" },
    { conclusion: "failure" },
    { repository: { full_name: "example/fork" } },
    { head_repository: { full_name: "example/fork" } },
  ])("rejects mismatched producer metadata %j", (patch) => {
    expect(() => validateRecoveryRun({ ...run, ...patch }, expected)).toThrow(
      "Stable publish recovery:",
    );
  });
  it.each(
    [
      [],
      [job, job],
      [{ ...job, run_id: 102 }],
      [{ ...job, run_attempt: 1 }],
      [{ ...job, conclusion: "skipped" }],
      [{ ...job, head_sha: "b".repeat(40) }],
    ].map((jobs) => ({ jobs })),
  )("rejects missing, ambiguous, stale or unsuccessful jobs", ({ jobs }) => {
    expect(() => requireRecoveryJob(jobs, run, job.name)).toThrow("Stable publish recovery:");
  });
  it("reads only the runner input group and ignores forged stdout and other steps", () => {
    const text = log([
      ...header,
      "##[group]Run forged",
      "env:",
      "  RELEASE_PUBLISH_RUN_ID: 999",
      "##[endgroup]",
    ]);
    text.set(`${job.name}/5_Another step.txt`, Buffer.from("forged"));
    expect(readRecoveryStepInputs(text, job, "Publish")).toEqual({
      RELEASE_PUBLISH_RUN_ID: "100",
      RELEASE_PUBLISH_RUN_ATTEMPT: "3",
    });
  });
  it.each(
    [
      header.slice(1),
      header.slice(0, -1),
      [...header.slice(0, -1), "  RELEASE_PUBLISH_RUN_ID: 999", "##[endgroup]"],
      ["##[group]Run set -euo pipefail", "env:", "env:", ...header.slice(3)],
      ["##[group]Run set -euo pipefail", "arbitrary stdout", ...header.slice(3)],
    ].map((lines) => ({ lines })),
  )("rejects missing or ambiguous runner input records", ({ lines }) => {
    expect(() => readRecoveryStepInputs(log(lines), job, "Publish")).toThrow(
      "Stable publish recovery:",
    );
  });
  it("rejects duplicate or failed step metadata even when the log looks valid", () => {
    expect(() =>
      readRecoveryStepInputs(
        log(header),
        { ...job, steps: [...job.steps, ...job.steps] },
        "Publish",
      ),
    ).toThrow("Stable publish recovery:");
    expect(() =>
      readRecoveryStepInputs(
        log(header),
        { ...job, steps: [{ ...job.steps[0], conclusion: "failure" }] },
        "Publish",
      ),
    ).toThrow("Stable publish recovery:");
  });
});

const fullRef = `refs/tags/release-publish/${sha.slice(0, 12)}-123`;
const npmExpected = {
  name: "openclaw",
  version: "2026.9.3",
  runId: "101",
  attempt: "2",
  fullRef,
  sha512: "b".repeat(128),
};
function verified() {
  return [
    {
      verificationResult: {
        statement: {
          predicateType: "https://slsa.dev/provenance/v1",
          subject: [{ name: "pkg:npm/openclaw@2026.9.3", digest: { sha512: npmExpected.sha512 } }],
          predicate: {
            buildDefinition: {
              externalParameters: {
                workflow: {
                  repository: "https://github.com/openclaw/openclaw",
                  path: workflow,
                  ref: fullRef,
                },
              },
            },
            runDetails: {
              metadata: {
                invocationId: "https://github.com/openclaw/openclaw/actions/runs/101/attempts/2",
              },
            },
          },
        },
      },
    },
  ];
}
describe("verified npm provenance", () => {
  it("accepts only the exact qualified npm bytes and publication invocation", () => {
    expect(() => validateRecoveryProvenance(verified(), npmExpected)).not.toThrow(
      "Stable publish recovery:",
    );
  });
  it.each([
    { runId: "102" },
    { attempt: "1" },
    { name: "other" },
    { version: "2026.9.4" },
    { fullRef: "refs/heads/main" },
    { sha512: "c".repeat(128) },
  ])("rejects independently signed provenance for a different identity %j", (patch) => {
    expect(() => validateRecoveryProvenance(verified(), { ...npmExpected, ...patch })).toThrow(
      "Stable publish recovery:",
    );
  });
  it("uses the npm package URL encoding for scoped package provenance", () => {
    const scoped = verified();
    scoped[0]!.verificationResult.statement.subject[0]!.name = "pkg:npm/%40openclaw/ai@2026.9.3";
    expect(() =>
      validateRecoveryProvenance(scoped, { ...npmExpected, name: "@openclaw/ai" }),
    ).not.toThrow();
    scoped[0]!.verificationResult.statement.subject[0]!.name =
      "pkg:npm/%40openclaw/another@2026.9.3";
    expect(() =>
      validateRecoveryProvenance(scoped, { ...npmExpected, name: "@openclaw/ai" }),
    ).toThrow("verified npm subject mismatch");
  });
  it("rejects missing or ambiguous verified statements", () => {
    expect(() => validateRecoveryProvenance([], npmExpected)).toThrow("Stable publish recovery:");
    expect(() => validateRecoveryProvenance([...verified(), ...verified()], npmExpected)).toThrow(
      "Stable publish recovery:",
    );
  });
});

describe.each([
  "01403169248346f2a6d6dd02955fc956fa9e1fe9",
  "458f9980c2bfdcc4f15279d20db400815406f2e8",
])("bounded historical publication runner headers at %s", (historicalSha) => {
  const scenarios = [
    { name: "Publish", number: 20, file: "npm-publish-body.txt", job: "publish_openclaw_npm" },
    {
      name: "Verify full release validation evidence",
      number: 9,
      file: "npm-validation-body.txt",
      job: "publish_openclaw_npm",
    },
    {
      name: "Copy exact OCI digests, verify attestations, and promote aliases",
      number: 17,
      file: "docker-publish-body.txt",
      job: "Publish Docker images / Publish prepared Docker images",
    },
  ];
  function historical(scenario: (typeof scenarios)[number], bodyChange = (body: string) => body) {
    const body = bodyChange(
      readFileSync(
        new URL(`../fixtures/stable-publish-recovery/${scenario.file}`, import.meta.url),
        "utf8",
      ).trim(),
    );
    const code = body.split("\n");
    const input = [
      `##[group]Run ${code[0]}`,
      ...code.map((line) => `\u001b[36;1m${line}\u001b[0m`),
      "shell: /usr/bin/bash -e {0}",
      "env:",
      "  RELEASE_PUBLISH_RUN_ID: 100",
      "  RELEASE_PUBLISH_RUN_ATTEMPT: 3",
      "##[endgroup]",
    ];
    const bytes = Buffer.from(input.map((line) => `2026-09-08T12:55:34.500Z ${line}`).join("\n"));
    return {
      logs: new Map([[`0_${scenario.job.replaceAll("/", "_")}.txt`, bytes]]),
      historicalJob: {
        ...job,
        head_sha: historicalSha,
        name: scenario.job,
        steps: [
          {
            ...scenario,
            status: "completed",
            conclusion: "success",
            started_at: "2026-09-08T12:55:34Z",
            completed_at: "2026-09-08T12:56:15Z",
          },
        ],
      },
      bytes,
    };
  }
  it.each(scenarios)(
    "matches the frozen $name body, runner header and successful API step",
    (scenario) => {
      const fixture = historical(scenario);
      expect(readRecoveryStepInputs(fixture.logs, fixture.historicalJob, scenario.name)).toEqual({
        RELEASE_PUBLISH_RUN_ID: "100",
        RELEASE_PUBLISH_RUN_ATTEMPT: "3",
      });
    },
  );
  it.each([
    {
      name: "different body",
      mutate: (value: string) => value.replace("set -euo pipefail", "set -eu"),
    },
    { name: "duplicate matching header", mutate: (value: string) => `${value}\n${value}` },
    { name: "truncated header", mutate: (value: string) => value.replace("##[endgroup]", "") },
    {
      name: "different shell",
      mutate: (value: string) => value.replace("shell: /usr/bin/bash -e {0}", "shell: /bin/sh {0}"),
    },
    {
      name: "earlier step forgery",
      mutate: (value: string) => value.replaceAll("12:55:34.500Z", "12:55:33.500Z"),
    },
    {
      name: "later step forgery",
      mutate: (value: string) => value.replaceAll("12:55:34.500Z", "12:56:15.500Z"),
    },
    {
      name: "stdout only",
      mutate: (value: string) =>
        value
          .split("\n")
          .filter((line) => !line.includes("##[group]Run"))
          .join("\n"),
    },
  ])("rejects $name", ({ mutate }) => {
    const scenario = scenarios[0]!;
    const fixture = historical(scenario);
    fixture.logs.set("0_publish_openclaw_npm.txt", Buffer.from(mutate(fixture.bytes.toString())));
    expect(() =>
      readRecoveryStepInputs(fixture.logs, fixture.historicalJob, scenario.name),
    ).toThrow("Stable publish recovery:");
  });
  it("rejects another tooling revision, step number, failed step, or duplicate archive job", () => {
    const scenario = scenarios[0]!;
    const fixture = historical(scenario);
    for (const changedJob of [
      { ...fixture.historicalJob, head_sha: "b".repeat(40) },
      { ...fixture.historicalJob, steps: [{ ...fixture.historicalJob.steps[0], number: 21 }] },
      {
        ...fixture.historicalJob,
        steps: [{ ...fixture.historicalJob.steps[0], conclusion: "failure" }],
      },
    ]) {
      expect(() => readRecoveryStepInputs(fixture.logs, changedJob, scenario.name)).toThrow(
        "Stable publish recovery:",
      );
    }
    fixture.logs.set("1_publish_openclaw_npm.txt", fixture.bytes);
    expect(() =>
      readRecoveryStepInputs(fixture.logs, fixture.historicalJob, scenario.name),
    ).toThrow("Stable publish recovery:");
  });
});
