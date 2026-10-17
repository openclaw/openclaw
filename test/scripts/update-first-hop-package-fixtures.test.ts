import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import {
  inspectFirstHopSource as inspectSource,
  LEGACY_UPDATE_COMPAT_CHUNKS as legacyChunks,
  listFirstHopSourceVersions as listSources,
  markFutureUpdateFixture as markFuture,
  packFirstHopUpdateFixture as packFirstHop,
  packFutureUpdateFixture as packFuture,
  packUnsupportedAdmissionFixture as packWithoutAdmission,
  removeLegacyUpdateCompatChunks as removeBridges,
} from "../../scripts/e2e/lib/update-first-hop-package-fixtures.mjs";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { UPDATE_COMPATIBILITY_CHUNK_HEADER as bridgeHeader } from "../../scripts/lib/update-compat-contract.mjs";
import { inspectControlUiRootAssets as inspectUi } from "../../src/infra/control-ui-assets.js";
import { collectPackageDistContentInventoryErrors as inventoryErrors } from "../../src/infra/package-dist-inventory.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { readJson, readJsonLines, runProcess } from "./upgrade-survivor-shard.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sourceVersions = ["2026.9.1", "2026.9.2", "2026.9.3"];
const emptyFiles: Record<string, string> = {};
const legacyModuleSource = "export function resolveNodeRunner() {}\n";
const contentInventory = "dist/postinstall-content-inventory.json";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

const tar = (...args: string[]) => execFileSync("tar", args);

function archive(root: string, output = path.join(root, "source.tgz")) {
  tar("-czf", output, "-C", root, "package");
  return output;
}

const member = (tarball: string, name: string) => tar("-xOf", tarball, `package/${name}`);

function writeFiles(root: string, files: Record<string, string>, mode?: number) {
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, { mode });
  }
}

function makeSource(version: string, root = tempDirs.make("openclaw-first-hop-source-")) {
  writeJson(path.join(root, "package/package.json"), { name: "openclaw", version });
  writeJson(path.join(root, "package/dist/build-info.json"), { version });
  const tarball = archive(root);
  const integrity = `sha512-${createHash("sha512").update(fs.readFileSync(tarball)).digest("base64")}`;
  return { version, tarball, integrity };
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function recordedChunk(
  chunkPath: string,
  owner = "src/cli/update-cli/update-command-service-command.ts",
  exported = "resolveNodeRunner",
) {
  return { path: chunkPath, imports: [{ owner, exports: [exported] }] };
}

function makePackageFixture({
  root = tempDirs.make("openclaw-first-hop-package-"),
  schemaVersions = { state: 1, agent: 1 },
  bridges = true,
  distFiles = emptyFiles,
} = {}) {
  const version = "2026.8.1";
  writeJson(path.join(root, "package.json"), {
    name: "openclaw",
    version,
    dependencies: { "@openclaw/ai": "2026.8.1" },
    openclaw: { schemaVersions, updateAdmissionProtocol: 1 },
  });
  const files = {
    "build-info.json": JSON.stringify({ version, buildId: "old-build" }),
    ...Object.fromEntries((bridges ? legacyChunks : []).map((name) => [name, legacyModuleSource])),
    "index.js": "export {};\n",
    ...distFiles,
  };
  writeFiles(path.join(root, "dist"), files);
  const inventory = Object.keys(files).map((name) => `dist/${name}`);
  writeJson(path.join(root, "dist/postinstall-inventory.json"), inventory);
  return root;
}

it("excludes newer-schema sources while retaining supported releases", () => {
  const root = makePackageFixture();
  writeJson(path.join(root, "dist/update-compat-inventory.json"), {
    releases: [
      { version: "2026.9.1", schemaVersions: { state: 1, agent: 1 } },
      { version: "2026.10.1-beta.1", schemaVersions: { state: 2, agent: 1 } },
      { version: "2026.10.1-beta.2", schemaVersions: { state: 1, agent: 2 } },
    ],
  });
  expect(listSources(root)).toEqual(["2026.9.1"]);
  expect(() => listSources(root, "2026.10.1-beta.1")).toThrow("unsupported");
});

it("selects recorded baselines and verifies their bytes before choosing restart controls", () => {
  const root = makePackageFixture();
  const restart = makeSource("2026.9.1");
  const cleanup = makeSource("2026.9.2");
  const empty = makeSource("2026.9.3");
  writeJson(path.join(root, "dist/update-compat-inventory.json"), {
    releases: [
      { ...restart, chunks: [recordedChunk("shared-DFJEouXv.js")] },
      {
        ...cleanup,
        chunks: [recordedChunk("cleanup-12345678.js", "src/cli/runtime-cleanup.ts", "cleanup")],
      },
      { ...empty, chunks: [] },
    ],
  });
  expect(listSources(root)).toEqual(sourceVersions);
  expect(listSources(root, "2026.9.3, 2026.9.1")).toEqual(["2026.9.1", "2026.9.3"]);
  expect(() => listSources(root, "2026.9.2 2026.9.9")).toThrow(
    "first-hop sources are not recorded in the candidate: 2026.9.9",
  );
  const inspect = ({ version, tarball }: ReturnType<typeof makeSource>) =>
    inspectSource(root, tarball, { version });
  const contracts = [restart, cleanup, empty].map(inspect);
  const missingChunks = contracts.map((row) => row.expectedMissingChunk);
  expect(missingChunks).toEqual(["shared-DFJEouXv.js", null, null]);
  expect(contracts.slice(1).map(({ negativeControl }) => negativeControl)).toEqual([
    { status: "not-applicable", reason: "no-recorded-lazy-service-restart-import" },
    { status: "not-applicable", reason: "source-has-no-recorded-post-swap-imports" },
  ]);
  fs.writeFileSync(restart.tarball, "not a tarball");
  expect(() => inspect(restart)).toThrow("source integrity mismatch");
  const legacyRoot = path.dirname(restart.tarball);
  makeSource("2026.8.2", legacyRoot);
  expect(inspectSource(root, restart.tarball)).toMatchObject({
    version: "2026.8.2",
    recorded: false,
    expectedMissingChunk: "shared-Y6bNiw2w.js",
  });
  makeSource("2026.8.1", legacyRoot);
  expect(() => inspectSource(root, restart.tarball)).toThrow(
    "unrecorded first-hop source requires an explicit expected missing chunk",
  );
});

it.each(["candidate", "harness"])("removes %s bridges, retaining stable/native entries", (kind) => {
  const native = "current-runtime-12345678.mjs";
  const stable = "new-runtime.js";
  const metadata = "dist/update-compat-inventory.json";
  const latest = readJson("scripts/lib/update-compat-inventory.json").releases.at(-1);
  const bridge =
    kind === "candidate"
      ? "new-runtime-12345678.mjs"
      : latest.chunks.find((chunk: { path: string }) => /-[A-Za-z0-9_-]{8}\.m?js$/.test(chunk.path))
          .path;
  const metadataFiles: Record<string, string> = {};
  if (kind === "candidate") {
    metadataFiles["update-compat-inventory.json"] = JSON.stringify({
      releases: [{ chunks: [bridge, stable, native].map((name) => ({ path: name })) }],
    });
  }
  const root = makePackageFixture({
    schemaVersions: { state: 1_000, agent: 1_000 },
    bridges: false,
    distFiles: {
      ...metadataFiles,
      [bridge]: `${bridgeHeader}\nexport {};\n`,
      [stable]: "export {};\n",
      [native]: "export {};\n",
    },
  });

  if (kind === "harness") {
    expect(listSources(root, latest.version)).toEqual([latest.version]);
  }
  expect(removeBridges(root)).toEqual([`dist/${bridge}`]);

  expect(fs.existsSync(path.join(root, "dist", bridge))).toBe(false);
  expect(
    [stable, native].map((name) => fs.readFileSync(path.join(root, "dist", name), "utf8")),
  ).toEqual(["export {};\n", "export {};\n"]);
  expect(readJson(path.join(root, "dist/postinstall-inventory.json"))).toEqual([
    "dist/build-info.json",
    "dist/index.js",
    ...(kind === "candidate" ? [metadata] : []),
    `dist/${stable}`,
    `dist/${native}`,
  ]);
});

it.each(["member", "missing inventory"])("does not hide %s faults", async (fault) => {
  const root = makePackageFixture();
  await writePackageDistInventory(root);
  if (fault === "missing inventory") {
    fs.rmSync(path.join(root, contentInventory));
    expect(() => markFuture(root)).toThrow("ENOENT");
  } else {
    fs.writeFileSync(path.join(root, "dist/index.js"), "export const unexpected = true;\n");
    markFuture(root);
    expect(await inventoryErrors(root)).not.toEqual([]);
  }
});

it("packs distinct self-update targets without changing the candidate artifact", async () => {
  const root = tempDirs.make("openclaw-same-schema-fixtures-");
  makePackageFixture({ root: path.join(root, "package") });
  const uiFiles = {
    "index.html": `<html data-openclaw-control-ui-build-id="old-build-${"a".repeat(64)}"><script src="./assets/startup.js"></script></html>`,
    "assets/startup.js": 'globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO = { buildId: "old-build" };',
    "sw.js": 'const EMBEDDED_CACHE_VERSION = "old-build";',
  };
  writeFiles(path.join(root, "package/dist/control-ui"), uiFiles);
  await writePackageDistInventory(path.join(root, "package"));
  const candidate = archive(root, path.join(root, "candidate.tgz"));
  const original = fs.readFileSync(candidate);
  const receipts: ReturnType<typeof packFirstHop>[] = [];
  const packers = [packFirstHop, packFuture, packWithoutAdmission];
  for (const [sequence, pack] of packers.entries()) {
    const output = path.join(root, `future-${sequence}.tgz`);
    const input = sequence === 0 ? candidate : path.join(root, `future-${sequence - 1}.tgz`);
    const receipt = pack(input, output, sequence);
    const unpacked = path.join(root, `unpacked-${sequence}`);
    fs.mkdirSync(unpacked);
    tar("-xzf", output, "-C", unpacked);
    const packageRoot = path.join(unpacked, "package");
    expect(await inventoryErrors(packageRoot)).toEqual([]);
    expect(fs.existsSync(path.join(packageRoot, contentInventory))).toBe(true);
    const pkg = JSON.parse(member(output, "package.json").toString());
    expect(pkg.version).toBe(receipt.targetVersion);
    expect(pkg.dependencies).toEqual({ "@openclaw/ai": "2026.8.1" });
    expect(pkg.openclaw).toEqual({
      schemaVersions: { state: 1, agent: 1 },
      ...(sequence === 2 ? {} : { updateAdmissionProtocol: 1 }),
    });
    expect(member(output, "dist/index.js").toString()).toBe("export {};\n");
    expect(receipt).toMatchObject({
      sourceVersion: sequence === 0 ? "2026.8.1" : `2026.8.2-first-hop.${sequence - 1}`,
      targetVersion: `2026.8.2-first-hop.${sequence}`,
    });
    const changed = ["dist/build-info.json", "package.json", contentInventory];
    if (sequence === 1) {
      changed.push(
        "dist/postinstall-inventory.json",
        ...legacyChunks.map((name) => `dist/${name}`),
      );
    }
    const members = tar("-tzf", output).toString().split("\n");
    expect(receipt.members.changes).toEqual(
      changed
        .toSorted((left, right) => left.localeCompare(right))
        .map((entry) => ({
          path: entry,
          before: sha256(member(input, entry)),
          after: members.includes(`package/${entry}`) ? sha256(member(output, entry)) : null,
        })),
    );
    for (const bridge of legacyChunks) {
      expect(members.includes(`package/dist/${bridge}`)).toBe(sequence === 0);
      if (sequence === 0) {
        expect(member(output, `dist/${bridge}`)).toEqual(member(candidate, `dist/${bridge}`));
      }
    }
    const buildInfo = readJson(path.join(packageRoot, "dist/build-info.json"));
    expect(buildInfo.version).toBe(receipt.targetVersion);
    const uiRoot = path.join(packageRoot, "dist/control-ui");
    expect(inspectUi(uiRoot, buildInfo.buildId)).toMatchObject({ kind: "ready" });
    for (const [relative, contents] of Object.entries(uiFiles)) {
      expect(fs.readFileSync(path.join(uiRoot, relative), "utf8")).toBe(contents);
    }
    receipts.push(receipt);
  }
  expect(new Set(receipts.map((receipt) => receipt.targetSha256)).size).toBe(3);
  expect(receipts[1]?.sourceSha256).toBe(receipts[0]?.targetSha256);
  expect(receipts[2]?.sourceSha256).toBe(receipts[1]?.targetSha256);
  expect(fs.readFileSync(candidate)).toEqual(original);
  expect(() => packFuture(candidate, candidate)).toThrow("new tarball path");
  expect(fs.readFileSync(candidate)).toEqual(original);
});

it.skipIf(process.platform === "win32")("routes recorded sources", () => {
  const root = fs.realpathSync(tempDirs.make("openclaw-first-hop-docker-"));
  const bin = path.join(root, "bin");
  const registry = path.join(root, "registry");
  const dockerArgs = path.join(root, "docker-args.json");
  makePackageFixture({ root: path.join(root, "package") });
  const sourceTarballs: Record<string, string> = {};
  const releases = sourceVersions.map((version, index) => {
    const { tarball, integrity } = makeSource(version, path.join(root, version));
    sourceTarballs[version] = tarball;
    return { version, integrity, chunks: [recordedChunk(legacyChunks[index]!)] };
  });
  writeJson(path.join(root, "package/dist/update-compat-inventory.json"), { releases });
  const tarball = archive(root, path.join(root, "candidate.tgz"));
  writeJson(path.join(registry, "prepublish-plugin-registry.json"), {
    candidateVersion: "2026.8.1",
    sourceSha: "a".repeat(40),
    packages: [],
  });
  writeFiles(
    bin,
    {
      docker: `#!${process.execPath}
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
if (process.argv[2] === "run") {
  const args = process.argv.slice(3);
  fs.appendFileSync(process.env.DOCKER_ARGS_FILE, JSON.stringify(args) + "\\n");
  const artifact = args.find(arg => arg.endsWith(":/tmp/openclaw-update-first-hop-artifacts")).split(":")[0];
  const sourceFile = path.join(artifact, "source.json");
  const source = fs.existsSync(sourceFile) ? JSON.parse(fs.readFileSync(sourceFile, "utf8")) : undefined;
  const inspect = (name) => {
    const mount = args.find(arg => arg.endsWith(":/tmp/openclaw-update-first-hop-" + name + ".tgz:ro"));
    if (!mount) return undefined;
    const archive = mount.split(":")[0];
    const manifest = JSON.parse(execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" }));
    const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\\n");
    return { version: manifest.version, entries };
  };
  fs.writeFileSync(path.join(artifact, "summary.json"), JSON.stringify({ source,
    candidate: inspect("candidate"), negative: inspect("negative"), future: inspect("future"), original: inspect("original") }));
}
`,
      npm: `#!${process.execPath}
import fs from "node:fs";
import path from "node:path";
const sources = ${JSON.stringify(sourceTarballs)};
const version = process.argv[3].slice("openclaw@".length);
const filename = path.basename(sources[version]);
fs.copyFileSync(sources[version], path.join(process.argv[process.argv.indexOf("--pack-destination") + 1], filename));
const packed = { filename };
process.stdout.write(JSON.stringify(version === "2026.9.2" ? { openclaw: packed } : [packed]));
`,
    },
    0o755,
  );
  const result = runProcess(
    "bash",
    ["scripts/e2e/update-first-hop-compat-docker.sh"],
    {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      DOCKER_ARGS_FILE: dockerArgs,
      OPENCLAW_QA_ALLOW_UPDATE_FIRST_HOP: "1",
      OPENCLAW_UPDATE_FIRST_HOP_DOCKER_RUN_TIMEOUT: "",
      OPENCLAW_UPDATE_FIRST_HOP_E2E_SKIP_BUILD: "1",
      OPENCLAW_UPDATE_FIRST_HOP_SOURCE_PACKAGE_TGZ: "",
      OPENCLAW_UPDATE_FIRST_HOP_SCENARIO: "all",
      OPENCLAW_UPDATE_FIRST_HOP_EXPECTED_MISSING_CHUNK: "shared-Y6bNiw2w.js",
      OPENCLAW_UPDATE_FIRST_HOP_CANDIDATE_PACKAGE_TGZ: tarball,
      OPENCLAW_UPDATE_FIRST_HOP_ARTIFACT_DIR: path.join(root, "artifacts"),
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: registry,
      OPENCLAW_DOCKER_E2E_SELECTED_SHA: "a".repeat(40),
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION: "2026.8.1",
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256: "",
    },
    30_000,
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const invocations = readJsonLines<string[]>(dockerArgs);
  expect(invocations).toHaveLength(3);
  const firstFixture = readJson(path.join(root, "artifacts/first-hop-fixture.json"));
  const secondFixture = readJson(path.join(root, "artifacts/second-hop-fixture.json"));
  expect(firstFixture.sourceSha256).toBe(sha256(fs.readFileSync(tarball)));
  expect(firstFixture.members.changes.map((entry: { path: string }) => entry.path)).toEqual([
    "dist/build-info.json",
    "package.json",
  ]);
  expect(secondFixture).toMatchObject({
    sourceSha256: firstFixture.targetSha256,
    removedCompatibilityChunks: [],
    retainedLegacyCompatibilityChunks: legacyChunks,
  });
  const summary = readJson(path.join(root, "artifacts/summary.json"));
  for (const artifact of summary.sources) {
    const fixtureDirectory = path.join(root, "artifacts", artifact.source.version);
    const negativeFixture = readJson(path.join(fixtureDirectory, "negative-fixture.json"));
    expect(readJson(path.join(fixtureDirectory, "second-hop-fixture.json"))).toEqual(secondFixture);
    expect(negativeFixture).toMatchObject({
      sourceSha256: firstFixture.targetSha256,
      sourceVersion: negativeFixture.targetVersion,
      removedCompatibilityChunks: [`dist/${artifact.source.expectedMissingChunk}`],
    });
    expect(artifact).toMatchObject({
      candidate: { version: "2026.8.2-first-hop.0" },
      negative: { version: "2026.8.2-first-hop.0" },
      future: { version: "2026.8.2-first-hop.1" },
      original: { version: "2026.8.1" },
    });
    for (const bridge of legacyChunks) {
      const memberPath = `package/dist/${bridge}`;
      expect([
        artifact.candidate.entries.includes(memberPath),
        artifact.negative.entries.includes(memberPath),
        artifact.future.entries.includes(memberPath),
      ]).toEqual([true, bridge !== artifact.source.expectedMissingChunk, true]);
    }
  }
  const expectedChunkEnv = "OPENCLAW_UPDATE_FIRST_HOP_EXPECTED_MISSING_CHUNK=";
  for (const [index, args] of invocations.entries()) {
    expect(args.find((arg) => arg.startsWith(expectedChunkEnv))).toBe(
      expectedChunkEnv + summary.sources[index].source.expectedMissingChunk,
    );
    const timeout = args.slice(args.indexOf("timeout"), args.indexOf("timeout") + 3);
    expect(timeout).toEqual(["timeout", "--kill-after=30s", "3200s"]);
    expect(args[args.indexOf("--entrypoint") + 1]).toBe(
      "/opt/openclaw-e2e/scripts/e2e/lib/prepublish-plugin-registry.sh",
    );
    expect(args).toEqual(
      expect.arrayContaining([
        `${registry}:/tmp/openclaw-prepublish-plugin-registry:ro`,
        `${tarball}:/tmp/openclaw-update-first-hop-original.tgz:ro`,
        "OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION=2026.8.1",
        "OPENCLAW_UPDATE_FIRST_HOP_SCENARIO=all",
        "bash",
        "scripts/e2e/lib/upgrade-survivor/update-first-hop-compat.sh",
      ]),
    );
  }
  expect(
    summary.sources.map((entry: { source: { version: string } }) => entry.source.version),
  ).toEqual(sourceVersions);
});
function transitionEvidence(root: string, ...args: string[]) {
  const executable = "scripts/e2e/lib/external-package-transition.mjs";
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  const result = runProcess(process.execPath, [executable, ...args], env);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

it("accepts applied content while schema publication is deferred", () => {
  const root = tempDirs.make("openclaw-external-transition-");
  fs.mkdirSync(path.join(root, "state"));
  const database = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"));
  database.exec(
    "PRAGMA user_version = 15; CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT)",
  );
  database
    .prepare("INSERT INTO config_machine_state VALUES (?, ?)")
    .run("state.schema.contentVersion", "16");
  database.close();
  const schema = transitionEvidence(root, "schema", "16");
  expect(schema).toEqual({ publishedVersion: 15, contentVersion: 16 });
});

it("records external installation without claiming an updater attempt", () => {
  const root = tempDirs.make("openclaw-external-transition-");
  writeJson(path.join(root, "schema-before.json"), { publishedVersion: 15, contentVersion: 15 });
  const schemaAfterDoctor = { publishedVersion: 15, contentVersion: 16 };
  writeJson(path.join(root, "schema-after-doctor.json"), schemaAfterDoctor);
  expect(transitionEvidence(root, "receipt", "2026.9.2", "2026.9.3", root)).toMatchObject({
    method: "external-package-manager-and-fresh-doctor",
    selfUpdatePassed: false,
    selfUpdate: { status: "not-run", method: "in-process-self-update" },
    schemaAfterDoctor: { publishedVersion: 15, contentVersion: 16 },
  });
});
