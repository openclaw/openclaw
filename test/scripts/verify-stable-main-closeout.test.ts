import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  readRecoveryStepInputs,
  requireRecoveryJob,
  validateRecoveryProvenance,
  validateRecoveryRun,
  verifyStablePublishRecovery,
} from "../../scripts/lib/stable-publish-recovery.mjs";
import { verifyStableMainCloseout } from "../../scripts/lib/stable-release-closeout.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sha = "a".repeat(40);
const oldAppcast = "<rss>older app release</rss>";
const pendingPlatforms = { macos: "pending", android: "pending", windows: "pending" };
const recoveryInputs = { RELEASE_PUBLISH_RUN_ID: "100", RELEASE_PUBLISH_RUN_ATTEMPT: "3" };
const releaseDefaults = { databaseId: 42, isDraft: false, isPrerelease: false };
function expectRecoveryFailure(operation: () => unknown) {
  expect(operation).toThrow("Stable publish recovery:");
}
function writeJson(file: string, value: unknown) {
  writeFileSync(file, JSON.stringify(value));
}
function writeExecutable(bin: string, name: string, source: string) {
  writeFileSync(path.join(bin, name), `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
}
function writeChecksum(file: string, kind = "valid", wrongFile = file) {
  const source = kind === "wrong-file" ? wrongFile : file;
  const digest =
    kind === "mismatch"
      ? "b".repeat(64)
      : createHash("sha256").update(readFileSync(source)).digest("hex");
  const name =
    kind === "wrong-file" && source === file ? "another-file.json" : path.basename(source);
  const entry = `${digest}  ${name}\n`;
  writeFileSync(`${file}.sha256`, kind === "duplicate" ? entry + entry : entry);
}
function expectFailure(result: ReturnType<typeof runCli>, message: string) {
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(message);
}
function expectReplay(
  fixture: { outputPath: string },
  result: ReturnType<typeof runCli>,
  bytes: string,
) {
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(fixture.outputPath)).toEqual(Buffer.from(bytes));
}
function expectChangedAsset(
  run: () => ReturnType<typeof runCli>,
  asset: { name: string; digest: string },
) {
  asset.digest = `sha256:${"d".repeat(64)}`;
  expectFailure(run(), `Recorded release asset changed or disappeared: ${asset.name}`);
}
function writeReleaseTrees(dir: string, version: string, appcast: string, git = false) {
  const changelog = `# Changelog\n\n## ${version}\n\n- Released.\n`;
  for (const name of ["main", "tag"]) {
    const root = path.join(dir, name);
    mkdirSync(root);
    if (git) {
      execFileSync("git", ["init", "--quiet", root]);
      writeFileSync(path.join(root, ".git/HEAD"), `${sha}\n`);
    }
    writeJson(path.join(root, "package.json"), { version });
    writeFileSync(path.join(root, "CHANGELOG.md"), changelog);
    writeFileSync(path.join(root, "appcast.xml"), appcast);
  }
  return changelog;
}
const cliArgs = (options: Record<string, string>) =>
  Object.entries(options).flatMap(([name, value]) => [`--${name}`, value]);
function closeoutArgs(tag: string, dir: string, date = new Date().toISOString().slice(0, 10)) {
  return cliArgs({
    tag,
    "main-dir": path.join(dir, "main"),
    "tag-dir": path.join(dir, "tag"),
    "release-json": path.join(dir, "release.json"),
    "full-release-validation-run-id": "11",
    "full-release-validation-run-attempt": "2",
    "release-publish-run-id": "12",
    "rollback-drill-id": "synthetic-drill",
    "rollback-drill-date": date,
    output: path.join(dir, "closeout.json"),
  });
}
function releaseFixture(tag: string, appcast = oldAppcast, git = false) {
  const dir = tempDirs.make("openclaw-closeout-");
  const version = tag.slice(1).replace(/-[1-9]\d*$/u, "");
  const changelog = writeReleaseTrees(dir, version, appcast, git);
  const date = new Date().toISOString().slice(0, 10);
  return {
    dir,
    releasePath: path.join(dir, "release.json"),
    outputPath: path.join(dir, "closeout.json"),
    originalPath: path.join(dir, "original.json"),
    args: closeoutArgs(tag, dir, date),
    params: {
      tag,
      mainPackageJson: { version },
      tagPackageJson: { version },
      mainChangelog: changelog,
      tagChangelog: changelog,
      mainAppcast: appcast,
      releaseTagSha: sha,
      mainSha: sha,
      fullReleaseValidationRunId: "11",
      fullReleaseValidationRunAttempt: "2",
      releasePublishRunId: "12",
      rollbackDrillId: "synthetic-drill",
      rollbackDrillDate: date,
      nowMs: Date.now(),
    },
  };
}

function macAssets(version: string) {
  return ["", "-arm64", "-x86_64"]
    .flatMap((suffix) =>
      ["zip", "dmg", "dSYM.zip"].map((ext) => `OpenClaw-${version}${suffix}.${ext}`),
    )
    .map((name) => ({ name, digest: `sha256:${"c".repeat(64)}` }));
}
function publishedFeeds(dir: string, version: string, thin: boolean) {
  return (thin ? ["", "arm64", "x86_64"] : [""]).flatMap((arch) => {
    const file = path.join(dir, `appcast${arch && `-${arch}`}.xml`);
    const suffix = arch && `-${arch}`;
    writeFileSync(
      file,
      `https://github.com/openclaw/openclaw/releases/download/v${version}/OpenClaw-${version}${suffix}.zip`,
    );
    return [`--published-appcast${arch && `-${arch.replace("_", "-")}`}`, file];
  });
}

function saveReceipt(fixture: {
  run(): ReturnType<typeof runCli>;
  outputPath: string;
  originalPath: string;
}) {
  const result = fixture.run();
  expect(result.status, result.stderr).toBe(0);
  const bytes = readFileSync(fixture.outputPath, "utf8");
  writeFileSync(fixture.originalPath, bytes);
  return bytes;
}

function assetNamed(assets: LinuxAsset[], name: string | RegExp) {
  return expectDefined(
    assets.find((asset) =>
      typeof name === "string" ? asset.name === name : name.test(asset.name),
    ),
    String(name),
  );
}

function runCli(...args: string[]) {
  return runNode(["scripts/verify-stable-main-closeout.mjs", ...args]);
}
function runNode(
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string; timeout?: number } = {},
) {
  return spawnSync(process.execPath, args, {
    cwd: path.resolve("."),
    encoding: "utf8",
    ...options,
  });
}

function closeoutFixture(version = "2026.9.6", recovery = true, appcast = oldAppcast) {
  const tag = `v${version}`;
  const fixture = releaseFixture(tag, appcast, true);
  const assets: Array<{ name: string; digest: string }> = [];
  const release = { tagName: tag, isDraft: false, isPrerelease: false, assets };
  const args = [...fixture.args, ...(recovery ? ["--allow-failed-publish-recovery", "true"] : [])];
  const run = (extra: string[] = [], env?: NodeJS.ProcessEnv) => {
    writeJson(fixture.releasePath, release);
    return runNode(["scripts/verify-stable-main-closeout.mjs", ...args, ...extra], { env });
  };
  return {
    ...fixture,
    release,
    run,
    replay: (extra: string[] = []) => run(["--existing-manifest", fixture.originalPath, ...extra]),
  };
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
    ...releaseDefaults,
    tagName: `v${version}`,
    assets,
  };
}

function linuxCloseoutFixture(carried = false, tag = "v2026.9.4") {
  const fixture = releaseFixture(tag);
  const { dir, releasePath, originalPath } = fixture;
  const version = tag.slice(1);
  const original = linuxPublication("2026.9.3");
  const evidence = linuxAsset(
    `openclaw-${version}-postpublish-evidence.json`,
    "immutable evidence",
  );
  const carrier = {
    ...releaseDefaults,
    tagName: tag,
    assets: [evidence],
  };
  if (carried) {
    carrier.assets.push(assetNamed(original.assets, "latest.json"));
  }
  const remotePath = path.join(dir, "remote.json");
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  writeExecutable(
    bin,
    "git",
    `
if (process.argv[2] !== '-C' || process.argv[4] !== 'rev-parse') throw new Error('Unexpected git operation');
process.stdout.write('${"a".repeat(40)}\\n');
`,
  );
  writeExecutable(
    bin,
    "gh",
    `
const fs = require('node:fs');
const args = process.argv.slice(2);
const releases = JSON.parse(fs.readFileSync(process.env.LINUX_CLOSEOUT_REMOTE, 'utf8'));
function reply(value) { process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value)); }
function metadata(release) { return {...release, assets: release.assets.map(({bytes, ...asset}) => asset)}; }
if (args[0] === 'api' && args[1]?.startsWith('repos/${linuxRepository}/commits/')) {
  reply('${"a".repeat(40)}\\n');
  process.exit(0);
}
if (args[0] === 'api' && args[1]?.startsWith('repos/${linuxRepository}/releases/tags/')) {
  const tag = args[1].slice('repos/${linuxRepository}/releases/tags/'.length);
  const release = releases[tag];
  if (!release) throw new Error('Missing release');
  reply({id: release.databaseId, tag_name: tag,
    draft: release.isDraft, prerelease: release.isPrerelease,
    assets: metadata(release).assets});
  process.exit(0);
}
const release = releases[args[2]];
if (args[0] !== 'release' || !release) throw new Error('Unexpected GitHub operation');
if (args[1] === 'view') {
  if (args[args.indexOf('--json') + 1].includes('databaseId')) throw new Error('Unknown JSON field: databaseId');
  reply(metadata(release));
} else if (args[1] === 'download') {
  const name = args[args.indexOf('--pattern') + 1];
  if (!['latest.json', 'SHA256SUMS.linux-app.txt', 'OpenClaw-' + args[2].slice(1) + '-linux.json'].includes(name)) throw new Error('Binary download forbidden');
  const asset = release.assets.find(asset => asset.name === name);
  if (!asset || typeof asset.bytes !== 'string') throw new Error('Missing asset');
  process.stdout.write(asset.bytes);
} else throw new Error('GitHub writes forbidden');
`,
  );
  const metadata = () => ({
    ...carrier,
    assets: carrier.assets.map(({ bytes: _bytes, ...asset }) => asset),
  });
  return {
    ...fixture,
    carrier,
    evidence,
    publishLinux() {
      carrier.assets = [evidence, ...linuxPublication(version).assets];
    },
    publishImmutable() {
      const publication = linuxPublication(version);
      const selector = assetNamed(publication.assets, "latest.json");
      const value = JSON.parse(expectDefined(selector.bytes, "selector bytes"));
      value.linuxPublication = {
        schemaVersion: 1,
        sourceSha: sha,
        toolingSha: "b".repeat(40),
        channelSha: "c".repeat(40),
        releaseId: 42,
        publicKeySha256: "d".repeat(64),
        assets: publication.assets
          .filter((asset) => asset.name !== "latest.json")
          .map(({ id, name, size, digest }) => ({ id, name, size, sha256: digest.slice(7) })),
      };
      carrier.assets.push(linuxAsset(`OpenClaw-${version}-linux.json`, JSON.stringify(value)));
    },
    params() {
      return { ...fixture.params, release: metadata() };
    },
    run(replay = false) {
      writeJson(releasePath, metadata());
      writeJson(remotePath, { [original.tagName]: original, [tag]: carrier });
      return runNode(
        [
          "scripts/verify-stable-main-closeout.mjs",
          ...fixture.args,
          ...(replay ? ["--existing-manifest", originalPath] : []),
        ],
        {
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
  it.each(["stableSoakWaiver", "laneWaiver"])(
    "refuses historical %s replay without rewriting the published receipt",
    (field) => {
      const fixture = linuxCloseoutFixture();
      const receipt = JSON.parse(saveReceipt(fixture));
      const original = JSON.stringify({ ...receipt, [field]: "historical published authority" });
      writeFileSync(fixture.originalPath, original);
      const result = fixture.run(true);
      expectFailure(result, "Historical waiver-bearing closeout receipt replay is unsupported");
      expect(result.stderr).toContain(
        "a fresh validation run cannot replace their published binding",
      );
      expect(readFileSync(fixture.originalPath, "utf8")).toBe(original);
    },
  );

  it("accepts only the validated exact late immutable Linux manifest", () => {
    const fixture = linuxCloseoutFixture();
    const original = saveReceipt(fixture);
    fixture.publishLinux();
    fixture.publishImmutable();
    expectReplay(fixture, fixture.run(true), original);
    const immutable = assetNamed(fixture.carrier.assets, /-linux\.json$/u);
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
      const bytes = saveReceipt(fixture);
      expect(JSON.parse(bytes).appPlatforms).toEqual(pendingPlatforms);
      fixture.publishLinux();
      expectReplay(fixture, fixture.run(true), bytes);
      expectChangedAsset(() => fixture.run(true), fixture.evidence);
    },
  );

  it("does not treat recorded Linux bundles as mutable updater selectors", () => {
    const fixture = linuxCloseoutFixture();
    fixture.publishLinux();
    saveReceipt(fixture);
    expectChangedAsset(() => fixture.run(true), assetNamed(fixture.carrier.assets, /\.AppImage$/u));
  });

  it("requires source checksum proof and a matching current selector digest", () => {
    const fixture = linuxCloseoutFixture();
    saveReceipt(fixture);
    fixture.publishLinux();
    const selector = assetNamed(fixture.carrier.assets, "latest.json");
    const digest = selector.digest;
    selector.digest = `sha256:${"d".repeat(64)}`;
    expectFailure(fixture.run(true), "carrier asset digest");
    selector.digest = digest;
    fixture.carrier.assets = fixture.carrier.assets.filter(
      (asset) => asset.name !== "SHA256SUMS.linux-app.txt",
    );
    expectFailure(fixture.run(true), "partial or inconsistent");
  });

  it("rejects missing or mismatched validated selector observations without rewriting a receipt", () => {
    const fixture = linuxCloseoutFixture();
    const bytes = saveReceipt(fixture);
    const existingManifest = JSON.parse(bytes);
    fixture.publishLinux();
    const selector = assetNamed(fixture.carrier.assets, "latest.json");
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

    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(result.stderr.trim()).toBe("--tag requires a value.");
  });

  it.each(["2026.6.8", "2026.9.6"])(
    "preserves pending %s closeout after app/feed publication",
    (version) => {
      const thin = version === "2026.9.6";
      const fixture = closeoutFixture(version);
      const { dir, release } = fixture;
      const evidence = {
        name: `openclaw-${version}-postpublish-evidence.json`,
        digest: `sha256:${"b".repeat(64)}`,
      };
      if (!thin) {
        release.assets.push(evidence);
      }
      const initialBytes = saveReceipt(fixture);
      expect(JSON.parse(initialBytes)).toMatchObject({
        apps: "pending",
        appcast: "pending",
        appPlatforms: { macos: "pending" },
        releasePublishRecovery: { npmDockerVerified: true },
      });
      if (!thin) {
        mkdirSync(path.join(dir, "main", "CHANGELOG"));
        writeFileSync(
          path.join(dir, "main", "CHANGELOG.md"),
          "# Changelog\n\n<!-- openclaw:split-changelog -->\n",
        );
        writeFileSync(
          path.join(dir, "main", "CHANGELOG", `${version}.md`),
          `## ${version}\n\n- Released.\n`,
        );
        expectReplay(fixture, fixture.replay(), initialBytes);
      }
      release.assets.push(
        ...macAssets(version).filter((asset) => thin || !asset.name.includes(`-${version}-`)),
      );
      if (!thin) {
        release.assets.push(
          ...[
            "OpenClaw-Android.apk",
            "OpenClaw-Android-SHA256SUMS.txt",
            "OpenClawCompanion-Setup-arm64.exe",
            "OpenClawCompanion-Setup-x64.exe",
            "OpenClawCompanion-SHA256SUMS.txt",
          ].map((name) => ({ name, digest: `sha256:${"c".repeat(64)}` })),
        );
        expectFailure(
          fixture.replay(),
          `main appcast.xml does not point at OpenClaw-${version}.zip`,
        );
      }
      expectReplay(fixture, fixture.replay(publishedFeeds(dir, version, thin)), initialBytes);

      if (!thin) {
        expectChangedAsset(() => fixture.replay(), evidence);
      }
    },
  );

  it("rejects removed waiver flags while preserving strict closeout replay", () => {
    const fixture = closeoutFixture();
    const { outputPath } = fixture;
    const bytes = saveReceipt(fixture);
    const recorded = JSON.parse(bytes);
    expect(recorded).not.toHaveProperty("stableSoakWaiver");
    expect(recorded).not.toHaveProperty("laneWaiver");

    expectReplay(fixture, fixture.replay(), bytes);
    for (const flag of ["--stable-soak-waiver", "--lane-waiver"]) {
      const rejected = fixture.run([flag, "2026.9.6 operator approved"]);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(`${flag} was removed`);
      expect(readFileSync(outputPath, "utf8")).toBe(bytes);
    }
  });

  it("records a withdrawn 2026.9.6 macOS appcast from the main commit lookup", () => {
    const version = "2026.9.6";
    const fixture = closeoutFixture(
      version,
      false,
      "<rss><sparkle:shortVersionString>2026.9.5</sparkle:shortVersionString></rss>",
    );
    const { dir, release, outputPath, originalPath } = fixture;
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    writeExecutable(
      bin,
      "gh",
      `
const expected = 'repos/openclaw/openclaw/commits?sha=${sha}&path=appcast.xml&per_page=100';
if (process.argv[2] !== 'api' || process.argv[3] !== expected || process.env.WITHDRAWAL_LOOKUPS !== 'allowed') {
  throw new Error('Unexpected GitHub operation: ' + process.argv.slice(2).join(' '));
}
process.stdout.write(JSON.stringify([
  { sha: 'b'.repeat(40), commit: { message: 'chore(release): update appcast for ${version}' } },
  { sha: 'c'.repeat(40), commit: { message: 'chore(release): withdraw the ${version} macOS build from the Sparkle feed\\n\\nRefs #156861\\n' } },
]));
`,
    );
    release.assets = macAssets(version);
    const run = (lookups: "allowed" | "forbidden", ...extra: string[]) =>
      fixture.run(extra, {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        WITHDRAWAL_LOOKUPS: lookups,
      });

    const initial = run("allowed");
    expect(initial.status, initial.stderr).toBe(0);
    const initialBytes = readFileSync(outputPath, "utf8");
    expect(JSON.parse(initialBytes)).toMatchObject({
      apps: "pending",
      appPlatforms: { macos: "withdrawn" },
      appcast: "withdrawn",
      appcastWithdrawal: { commit: "c".repeat(40), reason: "Refs #156861" },
    });
    writeFileSync(originalPath, initialBytes);
    expectReplay(fixture, run("forbidden", "--existing-manifest", originalPath), initialBytes);
  });
});

describe("stable closeout workflow keyed runs and tag-only replay", () => {
  const workflow = parse(
    readFileSync(path.resolve(".github/workflows/openclaw-stable-main-closeout.yml"), "utf8"),
  ) as {
    concurrency: { group: string; "cancel-in-progress": boolean | string };
    on: {
      workflow_dispatch: {
        inputs: Record<string, { required: boolean; type: string; default?: string | boolean }>;
      };
    };
    jobs: { verify: { concurrency: { group: string; "cancel-in-progress": boolean } } };
  };
  it("keeps push runs alive and serializes verification by resolved stable tag", () => {
    expect(workflow.concurrency).toMatchObject({
      "cancel-in-progress": false,
      group: expect.stringContaining("inputs.tag"),
    });
    expect(workflow.jobs.verify.concurrency).toEqual({
      group: "openclaw-stable-main-closeout-verify-${{ needs.resolve.outputs.tag }}",
      "cancel-in-progress": false,
    });
  });

  it("keeps non-tag replay inputs optional", () => {
    for (const [name, input] of Object.entries(workflow.on.workflow_dispatch.inputs)) {
      if (name === "tag") {
        continue;
      }
      expect(input.required, name).toBe(false);
      // Optional string inputs have an implicit empty default in GitHub Actions.
      expect(input.default ?? (input.type === "string" ? "" : undefined), name).toBeOneOf([
        "",
        false,
      ]);
    }
  });
});

type RoutingPatch = {
  manual?: boolean;
  conclusion?: string;
  npm?: string;
  docker?: string;
  recovery?: { reason?: string; npmPublishRunId?: string };
  code?: number;
  checksum?: string;
};
const routingCases: Array<[string, RoutingPatch]> = [
  ["ordinary successful parent", { manual: false, conclusion: "success", code: 0 }],
  ["failed parent without manual recovery", { manual: false }],
  ["legacy same-parent recovery", { code: 0 }],
  ["unrelated operator metadata", { recovery: { reason: "App assets are pending" }, code: 0 }],
  ["failed legacy npm publication", { npm: "failure" }],
  ["failed legacy Docker publication", { docker: "failure" }],
  ["incomplete split selectors", { recovery: { npmPublishRunId: "13" } }],
  ...["wrong-file", "duplicate", "mismatch"].map((checksum): [string, RoutingPatch] => [
    `rejects ${checksum} checksum`,
    { checksum },
  ]),
];
it.each(routingCases)("stable closeout publication routing preserves %s", (name, patch) => {
  const scenario = {
    manual: true,
    conclusion: "failure",
    npm: "success",
    docker: "success",
    code: 1,
    ...patch,
  };
  const workflow = readFileSync(".github/workflows/openclaw-stable-main-closeout.yml", "utf8");
  const block = workflow.match(
    /node --input-type=module - "\$RUNNER_TEMP\/release-publish-run.json"[^\n]+<<'NODE'\n([\s\S]*?)\n {10}NODE/u,
  )?.[1];
  if (!block) {
    throw new Error("Publication verifier node block missing");
  }
  const script = block
    .replace(/^ {10}/gmu, "")
    .replace(/(['"])\.\/\.closeout-tooling\/([^'"]+)\1/gu, (_match, _quote: string, file: string) =>
      JSON.stringify(pathToFileURL(path.resolve(file)).href),
    );
  const dir = tempDirs.make("openclaw-closeout-routing-");
  const run = path.join(dir, "run.json");
  const evidence = path.join(dir, "evidence.json");
  const manifest = path.join(dir, "manifest.json");
  writeJson(run, {
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
  });
  writeJson(evidence, {
    releasePublishRunId: "12",
    releaseTag: "v2026.6.8",
    releaseVersion: "2026.6.8",
    releaseSha: sha,
    operatorRecovery: scenario.recovery,
  });
  writeJson(manifest, { targetSha: sha });
  writeChecksum(evidence, patch.checksum, manifest);

  const result = runNode(["--input-type=module", "-", run, manifest, evidence], {
    input: script,
    env: {
      ...process.env,
      ALLOW_FAILED_PUBLISH_RECOVERY: String(scenario.manual),
      RELEASE_PUBLISH_RUN_ID: "12",
      RELEASE_TAG: "v2026.6.8",
      SOURCE_SHA: sha,
      RUNNER_TEMP: dir,
    },
  });
  expect(result.status, result.stderr).toBe(scenario.code);
  if (patch.checksum) {
    expect(result.stderr).toContain("Release evidence checksum must bind exactly");
  }
  if (name === "incomplete split selectors") {
    expect(result.stderr).toContain("invalid run or attempt ID");
  }
});
it.each(["valid", "wrong-file", "duplicate", "mismatch"])(
  "checks %s FRV manifest evidence",
  (kind) => {
    const dir = tempDirs.make("openclaw-frv-checksum-");
    const file = path.join(dir, "release-manifest.json");
    writeJson(file, { runId: "11", runAttempt: "2", targetSha: sha });
    writeChecksum(file, kind);
    const result = runCli("verify-checksum", file);
    expect(result.status, result.stderr).toBe(kind === "valid" ? 0 : 1);
    if (kind !== "valid") {
      expect(result.stderr).toContain("Release evidence checksum must bind exactly");
    }
  },
);
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

  it.each([
    {},
    { id: 102 },
    { run_attempt: 3 },
    { head_sha: "b".repeat(40) },
    { path: ".github/workflows/other.yml" },
    { event: "pull_request" },
    { status: "in_progress" },
    { conclusion: "failure" },
    { repository: { full_name: "example/fork" } },
    { head_repository: { full_name: "example/fork" } },
  ])("binds producer metadata to the exact publication: %j", (patch) => {
    if (Object.keys(patch).length === 0) {
      expect(validateRecoveryRun(run, expected)).toEqual(run);
    } else {
      expectRecoveryFailure(() => validateRecoveryRun({ ...run, ...patch }, expected));
    }
  });
  it.each(
    [
      [job],
      [],
      [job, job],
      [{ ...job, run_id: 102 }],
      [{ ...job, run_attempt: 1 }],
      [{ ...job, conclusion: "skipped" }],
      [{ ...job, head_sha: "b".repeat(40) }],
    ].map((jobs) => ({ jobs })),
  )("requires one successful job from the exact attempt: $jobs", ({ jobs }) => {
    if (jobs.length === 1 && jobs[0] === job) {
      expect(requireRecoveryJob(jobs, run, job.name)).toEqual(job);
    } else {
      expectRecoveryFailure(() => requireRecoveryJob(jobs, run, job.name));
    }
  });
  it("reads valid inputs despite forged stdout and other steps", () => {
    const text = log([
      ...header,
      "##[group]Run forged",
      "env:",
      "  RELEASE_PUBLISH_RUN_ID: 999",
      "##[endgroup]",
    ]);
    text.set(`${job.name}/5_Another step.txt`, Buffer.from("forged"));
    expect(readRecoveryStepInputs(text, job, "Publish")).toEqual(recoveryInputs);
  });
  it.each([
    ["missing group", header.slice(1)],
    ["truncated group", header.slice(0, -1)],
    ["duplicate field", [...header.slice(0, -1), "  RELEASE_PUBLISH_RUN_ID: 999", "##[endgroup]"]],
    [
      "duplicate environment",
      ["##[group]Run set -euo pipefail", "env:", "env:", ...header.slice(3)],
    ],
    [
      "stdout without environment",
      ["##[group]Run set -euo pipefail", "arbitrary stdout", ...header.slice(3)],
    ],
  ] satisfies Array<[string, string[]]>)(
    "rejects non-authoritative runner inputs: %s",
    (_name, lines) => {
      expectRecoveryFailure(() => readRecoveryStepInputs(log(lines), job, "Publish"));
    },
  );
  it("rejects duplicate or failed step metadata", () => {
    for (const metadata of [
      { ...job, steps: [...job.steps, ...job.steps] },
      { ...job, steps: [{ ...job.steps[0], conclusion: "failure" }] },
    ]) {
      expectRecoveryFailure(() => readRecoveryStepInputs(log(header), metadata, "Publish"));
    }
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
  const producer = {
    repository: "https://github.com/openclaw/openclaw",
    path: workflow,
    ref: fullRef,
  };
  const metadata = {
    invocationId: "https://github.com/openclaw/openclaw/actions/runs/101/attempts/2",
  };
  const statement = {
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ name: "pkg:npm/openclaw@2026.9.3", digest: { sha512: npmExpected.sha512 } }],
    predicate: {
      buildDefinition: { externalParameters: { workflow: producer } },
      runDetails: { metadata },
    },
  };
  return [{ verificationResult: { statement } }];
}
it.each([
  {},
  { runId: "102" },
  { attempt: "1" },
  { name: "other" },
  { version: "2026.9.4" },
  { fullRef: "refs/heads/main" },
  { sha512: "c".repeat(128) },
])("binds verified provenance to exact qualified bytes and invocation: %j", (patch) => {
  const operation = () => validateRecoveryProvenance(verified(), { ...npmExpected, ...patch });
  if (Object.keys(patch).length) {
    expectRecoveryFailure(operation);
  } else {
    expect(operation).not.toThrow("Stable publish recovery:");
  }
});
it("binds verified provenance to the encoded scoped package", () => {
  const results = verified();
  const subject = results[0]!.verificationResult.statement.subject[0]!;
  const identity = { ...npmExpected, name: "@openclaw/ai" };
  subject.name = "pkg:npm/%40openclaw/ai@2026.9.3";
  expect(() => validateRecoveryProvenance(results, identity)).not.toThrow();
  subject.name = "pkg:npm/%40openclaw/another@2026.9.3";
  expect(() => validateRecoveryProvenance(results, identity)).toThrow(
    "verified npm subject mismatch",
  );
});
it("rejects missing or ambiguous verified statements", () => {
  const results = verified();
  for (const statements of [[], [...results, ...results]]) {
    expectRecoveryFailure(() => validateRecoveryProvenance(statements, npmExpected));
  }
});
const historicalShas = [
  "01403169248346f2a6d6dd02955fc956fa9e1fe9",
  "458f9980c2bfdcc4f15279d20db400815406f2e8",
];
function historicalScenario(name: string, number: number, file: string, jobName = job.name) {
  return { name, number, file: `${file}-body.txt`, job: jobName };
}
const scenarios = [
  historicalScenario("Publish", 20, "npm-publish"),
  historicalScenario("Verify full release validation evidence", 9, "npm-validation"),
  historicalScenario(
    "Copy exact OCI digests, verify attestations, and promote aliases",
    17,
    "docker-publish",
    "Publish Docker images / Publish prepared Docker images",
  ),
];
function historical(scenario: (typeof scenarios)[number], historicalSha: string) {
  const code = readFileSync(
    new URL(`../fixtures/stable-publish-recovery/${scenario.file}`, import.meta.url),
    "utf8",
  )
    .trim()
    .split("\n");
  const input = [
    `##[group]Run ${code[0]}`,
    ...code.map((line) => `\u001b[36;1m${line}\u001b[0m`),
    ...header.slice(1),
  ];
  const bytes = Buffer.from(input.map((line) => `2026-09-08T12:55:34.500Z ${line}`).join("\n"));
  const logs = new Map([[`0_${scenario.job.replaceAll("/", "_")}.txt`, bytes]]);
  const historicalJob = {
    ...job,
    head_sha: historicalSha,
    name: scenario.job,
    steps: [
      {
        ...job.steps[0],
        ...scenario,
        started_at: "2026-09-08T12:55:34Z",
        completed_at: "2026-09-08T12:56:15Z",
      },
    ],
  };
  return {
    logs,
    historicalJob,
    bytes,
    read: (metadata: Parameters<typeof readRecoveryStepInputs>[1] = historicalJob) =>
      readRecoveryStepInputs(logs, metadata, scenario.name),
  };
}
it.each(
  historicalShas.flatMap((historicalSha) =>
    scenarios.map((scenario) => ({
      name: `${historicalSha} ${scenario.name}`,
      historicalSha,
      scenario,
    })),
  ),
)("validates the frozen runner header: $name", ({ historicalSha, scenario }) => {
  const fixture = historical(scenario, historicalSha);
  expect(fixture.read()).toEqual(recoveryInputs);
});
it.each([
  ["different body", (value) => value.replace("set -euo pipefail", "set -eu")],
  ["duplicate matching header", (value) => `${value}\n${value}`],
  ["truncated header", (value) => value.replace("##[endgroup]", "")],
  [
    "different shell",
    (value) => value.replace("shell: /usr/bin/bash -e {0}", "shell: /bin/sh {0}"),
  ],
  ["earlier step forgery", (value) => value.replaceAll("12:55:34.500Z", "12:55:33.500Z")],
  ["later step forgery", (value) => value.replaceAll("12:55:34.500Z", "12:56:15.500Z")],
  [
    "stdout only",
    (value) =>
      value
        .split("\n")
        .filter((line) => !line.includes("##[group]Run"))
        .join("\n"),
  ],
] satisfies Array<[string, (value: string) => string]>)(
  "rejects frozen runner-header forgery: %s",
  (_name, mutate) => {
    const scenario = scenarios[0]!;
    const fixture = historical(scenario, historicalShas[0]!);
    fixture.logs.set("0_publish_openclaw_npm.txt", Buffer.from(mutate(fixture.bytes.toString())));
    expectRecoveryFailure(() => fixture.read());
  },
);
it("rejects another tooling revision, step number, failed step, or duplicate archive job", () => {
  const scenario = scenarios[0]!;
  const fixture = historical(scenario, historicalShas[0]!);
  for (const changedJob of [
    { ...fixture.historicalJob, head_sha: "b".repeat(40) },
    { ...fixture.historicalJob, steps: [{ ...fixture.historicalJob.steps[0], number: 21 }] },
    {
      ...fixture.historicalJob,
      steps: [{ ...fixture.historicalJob.steps[0], conclusion: "failure" }],
    },
  ]) {
    expectRecoveryFailure(() => fixture.read(changedJob));
  }
  fixture.logs.set("1_publish_openclaw_npm.txt", fixture.bytes);
  expectRecoveryFailure(() => fixture.read());
});
