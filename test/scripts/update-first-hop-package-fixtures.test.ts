import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectFirstHopSource,
  LEGACY_UPDATE_COMPAT_CHUNKS,
  listFirstHopSourceVersions,
  markFutureUpdateFixture,
  packFirstHopUpdateFixture,
  packFutureUpdateFixture,
  packUnsupportedAdmissionFixture,
  removeLegacyUpdateCompatChunks,
} from "../../scripts/e2e/lib/update-first-hop-package-fixtures.mjs";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { UPDATE_COMPATIBILITY_CHUNK_HEADER } from "../../scripts/lib/update-compat-contract.mjs";
import { inspectControlUiRootAssets } from "../../src/infra/control-ui-assets.js";
import { collectPackageDistContentInventoryErrors } from "../../src/infra/package-dist-inventory.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function tar(...args: string[]) {
  return execFileSync("tar", args);
}

function archive(root: string, output = path.join(root, "source.tgz")) {
  tar("-czf", output, "-C", root, "package");
  return output;
}

function member(tarball: string, name: string) {
  return tar("-xOf", tarball, `package/${name}`);
}

function writeFiles(root: string, files: Record<string, string>) {
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
}

function makeSource(version: string, root = tempDirs.make("openclaw-first-hop-source-")) {
  writeJson(path.join(root, "package/package.json"), { name: "openclaw", version });
  const tarball = archive(root);
  return {
    version,
    tarball,
    integrity: `sha512-${createHash("sha512").update(fs.readFileSync(tarball)).digest("base64")}`,
  };
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function restartChunk(chunkPath: string) {
  return {
    path: chunkPath,
    imports: [
      {
        owner: "src/cli/update-cli/update-command-service-command.ts",
        exports: ["resolveNodeRunner"],
      },
    ],
  };
}

function makePackageFixture({
  root = tempDirs.make("openclaw-first-hop-package-"),
  schemaVersions = { state: 1, agent: 1 },
  legacyChunks = true,
} = {}) {
  const version = "2026.8.1";
  writeJson(path.join(root, "package.json"), {
    name: "openclaw",
    version,
    dependencies: { "@openclaw/ai": "2026.8.1" },
    openclaw: { schemaVersions, updateAdmissionProtocol: 1 },
  });
  writeJson(path.join(root, "dist", "build-info.json"), { version, buildId: "old-build" });
  const inventory = [
    "dist/build-info.json",
    ...(legacyChunks ? LEGACY_UPDATE_COMPAT_CHUNKS.map((name) => `dist/${name}`) : []),
    "dist/index.js",
  ];
  writeJson(path.join(root, "dist", "postinstall-inventory.json"), inventory);
  for (const name of legacyChunks ? LEGACY_UPDATE_COMPAT_CHUNKS : []) {
    fs.writeFileSync(path.join(root, "dist", name), "export function resolveNodeRunner() {}\n");
  }
  fs.writeFileSync(path.join(root, "dist", "index.js"), "export {};\n");
  return root;
}

describe("first-hop package fixtures", () => {
  it("excludes newer-schema sources while retaining supported releases", () => {
    const root = makePackageFixture();
    writeJson(path.join(root, "dist/update-compat-inventory.json"), {
      schemaVersion: 1,
      releases: [
        { version: "2026.9.1", schemaVersions: { state: 1, agent: 1 } },
        { version: "2026.10.1-beta.1", schemaVersions: { state: 2, agent: 1 } },
        { version: "2026.10.1-beta.2", schemaVersions: { state: 1, agent: 2 } },
      ],
    });
    expect(listFirstHopSourceVersions(root)).toEqual(["2026.9.1"]);
    expect(() => listFirstHopSourceVersions(root, "2026.10.1-beta.1")).toThrow("unsupported");
  });

  it("selects recorded baselines and verifies their bytes before choosing restart controls", () => {
    const root = makePackageFixture();
    const sources = {
      restart: makeSource("2026.9.1"),
      cleanup: makeSource("2026.9.2"),
      empty: makeSource("2026.9.3"),
    };
    writeJson(path.join(root, "dist/update-compat-inventory.json"), {
      releases: [
        { ...sources.restart, chunks: [restartChunk("shared-DFJEouXv.js")] },
        {
          ...sources.cleanup,
          chunks: [
            {
              path: "cleanup-12345678.js",
              imports: [{ owner: "src/cli/runtime-cleanup.ts", exports: ["cleanup"] }],
            },
          ],
        },
        { ...sources.empty, chunks: [] },
      ],
    });
    expect(listFirstHopSourceVersions(root)).toEqual(
      Object.values(sources).map(({ version }) => version),
    );
    expect(listFirstHopSourceVersions(root, "2026.9.3, 2026.9.1")).toEqual([
      "2026.9.1",
      "2026.9.3",
    ]);
    expect(() => listFirstHopSourceVersions(root, "2026.9.2 2026.9.9")).toThrow(
      "first-hop sources are not recorded in the candidate: 2026.9.9",
    );
    const inspect = ({ version, tarball }: ReturnType<typeof makeSource>) =>
      inspectFirstHopSource(root, tarball, { version });
    const contracts = Object.values(sources).map(inspect);
    expect(contracts.map(({ expectedMissingChunk }) => expectedMissingChunk)).toEqual([
      "shared-DFJEouXv.js",
      null,
      null,
    ]);
    expect(contracts.slice(1).map(({ negativeControl }) => negativeControl)).toEqual([
      { status: "not-applicable", reason: "no-recorded-lazy-service-restart-import" },
      { status: "not-applicable", reason: "source-has-no-recorded-post-swap-imports" },
    ]);
    fs.writeFileSync(sources.restart.tarball, "not a tarball");
    expect(() =>
      inspectFirstHopSource(root, sources.restart.tarball, { version: sources.restart.version }),
    ).toThrow("source integrity mismatch");
    const legacyRoot = path.dirname(sources.restart.tarball);
    makeSource("2026.8.2", legacyRoot);
    expect(inspectFirstHopSource(root, sources.restart.tarball)).toMatchObject({
      version: "2026.8.2",
      recorded: false,
      expectedMissingChunk: "shared-Y6bNiw2w.js",
    });
    makeSource("2026.8.1", legacyRoot);
    expect(() => inspectFirstHopSource(root, sources.restart.tarball)).toThrow(
      "unrecorded first-hop source requires an explicit expected missing chunk",
    );
  });

  it("removes the candidate's recorded bridges while retaining its stable entrypoints", () => {
    const root = makePackageFixture({ legacyChunks: false });
    const bridge = "new-runtime-12345678.mjs";
    const native = "current-runtime-12345678.mjs";
    const stable = "new-runtime.js";
    const metadata = "dist/update-compat-inventory.json";
    const inventoryPath = path.join(root, "dist/postinstall-inventory.json");
    writeJson(path.join(root, metadata), {
      releases: [{ chunks: [{ path: bridge }, { path: stable }, { path: native }] }],
    });
    writeFiles(path.join(root, "dist"), {
      [stable]: "export {};\n",
      [native]: "export {};\n",
      [bridge]: `${UPDATE_COMPATIBILITY_CHUNK_HEADER}\nexport {};\n`,
    });
    writeJson(inventoryPath, [
      ...readJson(inventoryPath),
      metadata,
      `dist/${bridge}`,
      `dist/${stable}`,
      `dist/${native}`,
    ]);

    removeLegacyUpdateCompatChunks(root);

    expect(fs.existsSync(path.join(root, "dist", bridge))).toBe(false);
    expect(
      [stable, native].map((name) => fs.readFileSync(path.join(root, "dist", name), "utf8")),
    ).toEqual(["export {};\n", "export {};\n"]);
    expect(readJson(inventoryPath)).toEqual([
      "dist/build-info.json",
      "dist/index.js",
      metadata,
      `dist/${stable}`,
      `dist/${native}`,
    ]);
  });

  it("reads harness records for candidates that no longer pack their inventory", () => {
    const harness = readJson("scripts/lib/update-compat-inventory.json") as {
      releases: { version: string; chunks: { path: string }[] }[];
    };
    const latest = harness.releases.at(-1)!;
    const root = makePackageFixture({
      schemaVersions: { state: 1_000, agent: 1_000 },
      legacyChunks: false,
    });
    const inventoryPath = path.join(root, "dist/postinstall-inventory.json");
    // One recorded chunk is a candidate bridge; the rest were never built here.
    const bridge = latest.chunks.find((chunk) => /-[A-Za-z0-9_-]{8}\.m?js$/.test(chunk.path))!;
    fs.writeFileSync(
      path.join(root, "dist", bridge.path),
      `${UPDATE_COMPATIBILITY_CHUNK_HEADER}\nexport {};\n`,
    );
    writeJson(inventoryPath, [...readJson(inventoryPath), `dist/${bridge.path}`]);

    expect(listFirstHopSourceVersions(root, latest.version)).toEqual([latest.version]);
    expect(removeLegacyUpdateCompatChunks(root)).toEqual([`dist/${bridge.path}`]);
    expect(fs.existsSync(path.join(root, "dist", bridge.path))).toBe(false);
  });

  it.each(["corrupt member", "missing advertised inventory"])(
    "does not hide %s when producing future fixtures",
    async (fault) => {
      const root = makePackageFixture();
      await writePackageDistInventory(root);
      if (fault === "missing advertised inventory") {
        fs.rmSync(path.join(root, "dist/postinstall-content-inventory.json"));
        expect(() => markFutureUpdateFixture(root)).toThrow("ENOENT");
      } else {
        fs.writeFileSync(path.join(root, "dist/index.js"), "export const unexpected = true;\n");
        markFutureUpdateFixture(root);
        expect(await collectPackageDistContentInventoryErrors(root)).not.toEqual([]);
      }
    },
  );

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
    const receipts: ReturnType<typeof packFirstHopUpdateFixture>[] = [];
    for (const sequence of [0, 1, 2]) {
      const output = path.join(root, `future-${sequence}.tgz`);
      const input = sequence === 0 ? candidate : path.join(root, `future-${sequence - 1}.tgz`);
      const receipt =
        sequence === 0
          ? packFirstHopUpdateFixture(input, output, sequence)
          : sequence === 1
            ? packFutureUpdateFixture(input, output, sequence)
            : packUnsupportedAdmissionFixture(input, output, sequence);
      const unpacked = path.join(root, `unpacked-${sequence}`);
      fs.mkdirSync(unpacked);
      tar("-xzf", output, "-C", unpacked);
      const packageRoot = path.join(unpacked, "package");
      expect(await collectPackageDistContentInventoryErrors(packageRoot)).toEqual([]);
      expect(fs.existsSync(path.join(packageRoot, "dist/postinstall-content-inventory.json"))).toBe(
        true,
      );
      const pkg = JSON.parse(member(output, "package.json").toString());
      expect(pkg.version).toBe(receipt.targetVersion);
      expect(pkg.dependencies).toEqual({ "@openclaw/ai": "2026.8.1" });
      expect(pkg.openclaw).toEqual({
        schemaVersions: { state: 1, agent: 1 },
        ...(sequence === 2 ? {} : { updateAdmissionProtocol: 1 }),
      });
      expect(member(output, "dist/index.js").toString()).toBe("export {};\n");
      expect(receipt.sourceVersion).toBe(
        sequence === 0 ? "2026.8.1" : `2026.8.2-first-hop.${sequence - 1}`,
      );
      expect(receipt.members.changes.map((entry: { path: string }) => entry.path)).toEqual(
        [
          "dist/build-info.json",
          "package.json",
          "dist/postinstall-content-inventory.json",
          ...(sequence === 1
            ? [
                "dist/postinstall-inventory.json",
                ...LEGACY_UPDATE_COMPAT_CHUNKS.map((name) => `dist/${name}`),
              ]
            : []),
        ].toSorted((left, right) => left.localeCompare(right)),
      );
      const members = tar("-tzf", output).toString();
      for (const change of receipt.members.changes) {
        const entry = `package/${change.path}`;
        expect([change.before, change.after]).toEqual([
          sha256(member(input, change.path)),
          members.split("\n").includes(entry) ? sha256(member(output, change.path)) : null,
        ]);
      }
      for (const bridge of LEGACY_UPDATE_COMPAT_CHUNKS) {
        expect(members.includes(`package/dist/${bridge}`)).toBe(sequence === 0);
        if (sequence === 0) {
          expect(member(output, `dist/${bridge}`)).toEqual(member(candidate, `dist/${bridge}`));
        }
      }
      const buildInfo = readJson(path.join(packageRoot, "dist/build-info.json"));
      expect(buildInfo.version).toBe(receipt.targetVersion);
      const uiRoot = path.join(packageRoot, "dist/control-ui");
      expect(inspectControlUiRootAssets(uiRoot, buildInfo.buildId)).toMatchObject({
        kind: "ready",
      });
      for (const [relative, contents] of Object.entries(uiFiles)) {
        expect(fs.readFileSync(path.join(uiRoot, relative), "utf8")).toBe(contents);
      }
      receipts.push(receipt);
    }
    expect(receipts.map((receipt) => receipt.targetVersion)).toEqual([
      "2026.8.2-first-hop.0",
      "2026.8.2-first-hop.1",
      "2026.8.2-first-hop.2",
    ]);
    expect(new Set(receipts.map((receipt) => receipt.targetSha256)).size).toBe(3);
    expect(receipts[1]?.sourceSha256).toBe(receipts[0]?.targetSha256);
    expect(receipts[2]?.sourceSha256).toBe(receipts[1]?.targetSha256);
    expect(fs.readFileSync(candidate)).toEqual(original);
    expect(() => packFutureUpdateFixture(candidate, candidate)).toThrow("new tarball path");
    expect(fs.readFileSync(candidate)).toEqual(original);
  });

  it.skipIf(process.platform === "win32")("routes recorded sources", () => {
    const root = fs.realpathSync(tempDirs.make("openclaw-first-hop-docker-"));
    const bin = path.join(root, "bin");
    const registry = path.join(root, "registry");
    const dockerArgs = path.join(root, "docker-args.json");
    fs.mkdirSync(bin);
    makePackageFixture({ root: path.join(root, "package") });
    const sourceTarballs: Record<string, string> = {};
    const releases = ["2026.9.1", "2026.9.2", "2026.9.3"].map((version, index) => {
      const expectedChunk = LEGACY_UPDATE_COMPAT_CHUNKS[index];
      if (!expectedChunk) {
        throw new Error(`missing recorded compatibility chunk fixture ${index}`);
      }
      const sourceRoot = path.join(root, version);
      writeJson(path.join(sourceRoot, "package/dist/build-info.json"), { version });
      const { tarball, integrity } = makeSource(version, sourceRoot);
      sourceTarballs[version] = tarball;
      return { version, integrity, chunks: [restartChunk(expectedChunk)] };
    });
    writeJson(path.join(root, "package/dist/update-compat-inventory.json"), { releases });
    const tarball = archive(root, path.join(root, "candidate.tgz"));
    writeJson(path.join(registry, "prepublish-plugin-registry.json"), {
      candidateVersion: "2026.8.1",
      sourceSha: "a".repeat(40),
      packages: [],
    });
    fs.writeFileSync(
      path.join(bin, "docker"),
      `#!${process.execPath}
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
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(bin, "npm"),
      `#!${process.execPath}
import fs from "node:fs";
import path from "node:path";
const sources = ${JSON.stringify(sourceTarballs)};
const version = process.argv[3].slice("openclaw@".length);
const filename = path.basename(sources[version]);
fs.copyFileSync(sources[version], path.join(process.argv[process.argv.indexOf("--pack-destination") + 1], filename));
const packed = { filename };
process.stdout.write(JSON.stringify(version === "2026.9.2" ? { openclaw: packed } : [packed]));
`,
      { mode: 0o755 },
    );
    const result = spawnSync("bash", ["scripts/e2e/update-first-hop-compat-docker.sh"], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
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
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const invocations: string[][] = fs
      .readFileSync(dockerArgs, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
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
      retainedLegacyCompatibilityChunks: LEGACY_UPDATE_COMPAT_CHUNKS,
    });
    const summary = readJson(path.join(root, "artifacts/summary.json"));
    for (const artifact of summary.sources) {
      const fixtureDirectory = path.join(root, "artifacts", artifact.source.version);
      const negativeFixture = readJson(path.join(fixtureDirectory, "negative-fixture.json"));
      expect(readJson(path.join(fixtureDirectory, "second-hop-fixture.json"))).toEqual(
        secondFixture,
      );
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
      for (const bridge of LEGACY_UPDATE_COMPAT_CHUNKS) {
        expect(artifact.candidate.entries).toContain(`package/dist/${bridge}`);
        if (bridge === artifact.source.expectedMissingChunk) {
          expect(artifact.negative.entries).not.toContain(`package/dist/${bridge}`);
        } else {
          expect(artifact.negative.entries).toContain(`package/dist/${bridge}`);
        }
        expect(artifact.future.entries).toContain(`package/dist/${bridge}`);
      }
    }
    for (const args of invocations) {
      expect(args.slice(args.indexOf("timeout"), args.indexOf("timeout") + 3)).toEqual([
        "timeout",
        "--kill-after=30s",
        "3200s",
      ]);
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
    ).toEqual(["2026.9.1", "2026.9.2", "2026.9.3"]);
    expect(
      invocations.map((args) =>
        args.find((arg) => arg.startsWith("OPENCLAW_UPDATE_FIRST_HOP_EXPECTED_MISSING_CHUNK=")),
      ),
    ).toEqual(
      summary.sources.map(
        (entry: { source: { expectedMissingChunk: string } }) =>
          `OPENCLAW_UPDATE_FIRST_HOP_EXPECTED_MISSING_CHUNK=${entry.source.expectedMissingChunk}`,
      ),
    );
  });
});

const transitionHelper = path.resolve("scripts/e2e/lib/external-package-transition.mjs");

function makeTransitionEvidenceFixture() {
  const root = tempDirs.make("openclaw-external-transition-");
  const file = (name: string, value: unknown) => {
    const target = path.join(root, name);
    fs.writeFileSync(target, JSON.stringify(value));
    return target;
  };
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [transitionHelper, ...args], {
      encoding: "utf8",
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
    });
  return { root, file, run };
}

describe("external package transition evidence", () => {
  it("accepts applied content while schema publication is deferred", () => {
    const { root, run } = makeTransitionEvidenceFixture();
    fs.mkdirSync(path.join(root, "state"));
    const database = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"));
    database.exec(
      "PRAGMA user_version = 15; CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT)",
    );
    database
      .prepare("INSERT INTO config_machine_state VALUES (?, ?)")
      .run("state.schema.contentVersion", "16");
    database.close();
    const result = run("schema", "16");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ publishedVersion: 15, contentVersion: 16 });
  });

  it("records external installation without claiming an updater attempt", () => {
    const { root, run, file } = makeTransitionEvidenceFixture();
    file("schema-before.json", { publishedVersion: 15, contentVersion: 15 });
    file("schema-after-doctor.json", { publishedVersion: 15, contentVersion: 16 });
    const result = run("receipt", "2026.9.2", "2026.9.3", root);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      method: "external-package-manager-and-fresh-doctor",
      selfUpdatePassed: false,
      selfUpdate: { status: "not-run", method: "in-process-self-update" },
      schemaAfterDoctor: { publishedVersion: 15, contentVersion: 16 },
    });
  });
});
