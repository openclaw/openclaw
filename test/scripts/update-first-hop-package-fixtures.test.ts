import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  FUTURE_FIXTURE_VERSION,
  inspectFirstHopSource,
  LEGACY_UPDATE_COMPAT_CHUNKS,
  listFirstHopSourceVersions,
  markFutureUpdateFixture,
  packFirstHopUpdateFixture,
  packFutureUpdateFixture,
  removeLegacyUpdateCompatChunks,
} from "../../scripts/e2e/lib/update-first-hop-package-fixtures.mjs";
import { UPDATE_COMPATIBILITY_CHUNK_HEADER } from "../../scripts/lib/update-compat-contract.mjs";
import { inspectControlUiRootAssets } from "../../src/infra/control-ui-assets.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makePackageFixture() {
  const root = tempDirs.make("openclaw-first-hop-package-");
  writeJson(path.join(root, "package.json"), {
    name: "openclaw",
    version: "2026.8.1",
    dependencies: { "@openclaw/ai": "2026.8.1" },
  });
  writeJson(path.join(root, "dist", "build-info.json"), {
    version: "2026.8.1",
    commit: "a".repeat(40),
    builtAt: "2026-09-02T00:00:00.000Z",
    buildId: "old-build",
  });
  const inventory = [
    "dist/build-info.json",
    ...LEGACY_UPDATE_COMPAT_CHUNKS.map((name) => `dist/${name}`),
    "dist/index.js",
  ];
  writeJson(path.join(root, "dist", "postinstall-inventory.json"), inventory);
  for (const name of LEGACY_UPDATE_COMPAT_CHUNKS) {
    fs.writeFileSync(path.join(root, "dist", name), "export function resolveNodeRunner() {}\n");
  }
  fs.writeFileSync(path.join(root, "dist", "index.js"), "export {};\n");
  return root;
}

describe("first-hop package fixtures", () => {
  it("selects recorded baselines and verifies their bytes before choosing restart controls", () => {
    const root = makePackageFixture();
    const createSource = (version: string) => {
      const sourceRoot = tempDirs.make("openclaw-first-hop-source-");
      writeJson(path.join(sourceRoot, "package/package.json"), { name: "openclaw", version });
      const tarball = path.join(sourceRoot, "source.tgz");
      execFileSync("tar", ["-czf", tarball, "-C", sourceRoot, "package"]);
      return {
        version,
        tarball,
        integrity: `sha512-${createHash("sha512").update(fs.readFileSync(tarball)).digest("base64")}`,
      };
    };
    const sources = {
      restart: createSource("2026.9.1"),
      cleanup: createSource("2026.9.2"),
      empty: createSource("2026.9.3"),
    };
    writeJson(path.join(root, "dist/update-compat-inventory.json"), {
      releases: Object.values(sources).map(({ version, integrity }) => ({
        version,
        integrity,
        chunks:
          version === "2026.9.1"
            ? [
                {
                  path: "shared-DFJEouXv.js",
                  imports: [
                    {
                      owner: "src/cli/update-cli/update-command-service-command.ts",
                      exports: ["resolveNodeRunner"],
                    },
                  ],
                },
              ]
            : version === "2026.9.2"
              ? [
                  {
                    path: "cleanup-12345678.js",
                    imports: [{ owner: "src/cli/runtime-cleanup.ts", exports: ["cleanup"] }],
                  },
                ]
              : [],
      })),
    });
    expect(listFirstHopSourceVersions(root)).toEqual(
      Object.values(sources).map(({ version }) => version),
    );
    const inspect = ({ version, tarball }: ReturnType<typeof createSource>) =>
      inspectFirstHopSource(root, tarball, { version });
    const contracts = {
      restart: inspect(sources.restart),
      cleanup: inspect(sources.cleanup),
      empty: inspect(sources.empty),
    };
    expect(
      Object.values(contracts).map(({ expectedMissingChunk }) => expectedMissingChunk),
    ).toEqual(["shared-DFJEouXv.js", null, null]);
    expect(contracts.cleanup.negativeControl).toEqual({
      status: "not-applicable",
      reason: "no-recorded-lazy-service-restart-import",
    });
    expect(contracts.empty.negativeControl).toEqual({
      status: "not-applicable",
      reason: "source-has-no-recorded-post-swap-imports",
    });
    fs.writeFileSync(sources.restart.tarball, "not a tarball");
    expect(() =>
      inspectFirstHopSource(root, sources.restart.tarball, { version: sources.restart.version }),
    ).toThrow("source integrity mismatch");
    const legacyRoot = path.dirname(sources.restart.tarball);
    writeJson(path.join(legacyRoot, "package/package.json"), {
      name: "openclaw",
      version: "2026.8.2",
    });
    execFileSync("tar", ["-czf", sources.restart.tarball, "-C", legacyRoot, "package"]);
    expect(inspectFirstHopSource(root, sources.restart.tarball)).toMatchObject({
      version: "2026.8.2",
      recorded: false,
      expectedMissingChunk: "shared-Y6bNiw2w.js",
    });
    writeJson(path.join(legacyRoot, "package/package.json"), {
      name: "openclaw",
      version: "2026.8.1",
    });
    execFileSync("tar", ["-czf", sources.restart.tarball, "-C", legacyRoot, "package"]);
    expect(() => inspectFirstHopSource(root, sources.restart.tarball)).toThrow(
      "unrecorded first-hop source requires an explicit expected missing chunk",
    );
  });

  it("removes the candidate's recorded bridges while retaining its stable entrypoints", () => {
    const root = makePackageFixture();
    const bridge = "new-runtime-12345678.mjs";
    const native = "current-runtime-12345678.mjs";
    const stable = "new-runtime.js";
    const metadata = "dist/update-compat-inventory.json";
    writeJson(path.join(root, metadata), {
      releases: [{ chunks: [{ path: bridge }, { path: stable }, { path: native }] }],
    });
    for (const name of [stable, native]) {
      fs.writeFileSync(path.join(root, "dist", name), "export {};\n");
    }
    fs.writeFileSync(
      path.join(root, "dist", bridge),
      `${UPDATE_COMPATIBILITY_CHUNK_HEADER}\nexport {};\n`,
    );
    const inventoryPath = path.join(root, "dist/postinstall-inventory.json");
    writeJson(inventoryPath, [
      ...JSON.parse(fs.readFileSync(inventoryPath, "utf8")),
      metadata,
      `dist/${bridge}`,
      `dist/${stable}`,
      `dist/${native}`,
    ]);

    removeLegacyUpdateCompatChunks(root);

    expect(fs.existsSync(path.join(root, "dist", bridge))).toBe(false);
    expect(fs.readFileSync(path.join(root, "dist", stable), "utf8")).toBe("export {};\n");
    expect(fs.readFileSync(path.join(root, "dist", native), "utf8")).toBe("export {};\n");
    expect(JSON.parse(fs.readFileSync(inventoryPath, "utf8"))).toEqual([
      "dist/build-info.json",
      "dist/index.js",
      metadata,
      `dist/${stable}`,
      `dist/${native}`,
    ]);
  });

  it("removes only the declared legacy compatibility inputs", () => {
    const root = makePackageFixture();
    removeLegacyUpdateCompatChunks(root);

    const inventory = JSON.parse(
      fs.readFileSync(path.join(root, "dist", "postinstall-inventory.json"), "utf8"),
    ) as string[];
    expect(inventory).toEqual(["dist/build-info.json", "dist/index.js"]);
    for (const name of LEGACY_UPDATE_COMPAT_CHUNKS) {
      expect(fs.existsSync(path.join(root, "dist", name))).toBe(false);
    }
    expect(fs.readFileSync(path.join(root, "dist", "index.js"), "utf8")).toBe("export {};\n");
  });

  it("marks a distinct future package after the compatibility window closes", () => {
    const root = makePackageFixture();
    markFutureUpdateFixture(root);

    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const buildInfo = JSON.parse(
      fs.readFileSync(path.join(root, "dist", "build-info.json"), "utf8"),
    );
    expect(packageJson.version).toBe(FUTURE_FIXTURE_VERSION);
    expect(packageJson.dependencies).toEqual({ "@openclaw/ai": "2026.8.1" });
    expect(buildInfo.version).toBe(FUTURE_FIXTURE_VERSION);
    expect(buildInfo.buildId).toBe("old-build");
    const inventory = JSON.parse(
      fs.readFileSync(path.join(root, "dist", "postinstall-inventory.json"), "utf8"),
    ) as string[];
    expect(inventory).toEqual(["dist/build-info.json", "dist/index.js"]);
    for (const name of LEGACY_UPDATE_COMPAT_CHUNKS) {
      expect(fs.existsSync(path.join(root, "dist", name))).toBe(false);
    }
  });

  it("packs distinct self-update targets without changing the candidate artifact", () => {
    const root = tempDirs.make("openclaw-same-schema-fixtures-");
    fs.cpSync(makePackageFixture(), path.join(root, "package"), { recursive: true });
    const uiFiles = {
      "index.html": `<html data-openclaw-control-ui-build-id="old-build-${"a".repeat(64)}"><script src="./assets/startup.js"></script></html>`,
      "assets/startup.js": 'globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO = { buildId: "old-build" };',
      "sw.js": 'const EMBEDDED_CACHE_VERSION = "old-build";',
    };
    for (const [relative, contents] of Object.entries(uiFiles)) {
      const file = path.join(root, "package", "dist", "control-ui", relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
    }
    const candidate = path.join(root, "candidate.tgz");
    execFileSync("tar", ["-czf", candidate, "-C", root, "package"]);
    const original = fs.readFileSync(candidate);
    const receipts = [0, 1].map((sequence) => {
      const output = path.join(root, `future-${sequence}.tgz`);
      const input = sequence === 0 ? candidate : path.join(root, "future-0.tgz");
      const receipt =
        sequence === 0
          ? packFirstHopUpdateFixture(input, output, sequence)
          : packFutureUpdateFixture(input, output, sequence);
      const pkg = JSON.parse(
        execFileSync("tar", ["-xOf", output, "package/package.json"], { encoding: "utf8" }),
      );
      expect(pkg.version).toBe(receipt.targetVersion);
      expect(pkg.dependencies).toEqual({ "@openclaw/ai": "2026.8.1" });
      expect(
        execFileSync("tar", ["-xOf", output, "package/dist/index.js"], { encoding: "utf8" }),
      ).toBe("export {};\n");
      expect(receipt.sourceVersion).toBe(sequence === 0 ? "2026.8.1" : FUTURE_FIXTURE_VERSION);
      expect(receipt.members.changes.map((entry: { path: string }) => entry.path)).toEqual(
        [
          "dist/build-info.json",
          "package.json",
          ...(sequence === 0
            ? []
            : [
                "dist/postinstall-inventory.json",
                ...LEGACY_UPDATE_COMPAT_CHUNKS.map((name) => `dist/${name}`),
              ]),
        ].toSorted((left, right) => left.localeCompare(right)),
      );
      const members = execFileSync("tar", ["-tzf", output], { encoding: "utf8" });
      for (const change of receipt.members.changes) {
        const entry = `package/${change.path}`;
        const beforeBytes = execFileSync("tar", ["-xOf", input, entry]);
        expect(change.before).toBe(createHash("sha256").update(beforeBytes).digest("hex"));
        expect(change.after).toBe(
          members.split("\n").includes(entry)
            ? createHash("sha256")
                .update(execFileSync("tar", ["-xOf", output, entry]))
                .digest("hex")
            : null,
        );
      }
      for (const bridge of LEGACY_UPDATE_COMPAT_CHUNKS) {
        expect(members.includes(`package/dist/${bridge}`)).toBe(sequence === 0);
        if (sequence === 0) {
          expect(execFileSync("tar", ["-xOf", output, `package/dist/${bridge}`])).toEqual(
            execFileSync("tar", ["-xOf", candidate, `package/dist/${bridge}`]),
          );
        }
      }
      const unpacked = path.join(root, `unpacked-${sequence}`);
      fs.mkdirSync(unpacked);
      execFileSync("tar", ["-xzf", output, "-C", unpacked]);
      const buildInfo = JSON.parse(
        fs.readFileSync(path.join(unpacked, "package", "dist", "build-info.json"), "utf8"),
      );
      expect(buildInfo.version).toBe(receipt.targetVersion);
      const uiRoot = path.join(unpacked, "package", "dist", "control-ui");
      expect(inspectControlUiRootAssets(uiRoot, buildInfo.buildId)).toMatchObject({
        kind: "ready",
      });
      for (const [relative, contents] of Object.entries(uiFiles)) {
        expect(fs.readFileSync(path.join(uiRoot, relative), "utf8")).toBe(contents);
      }
      return receipt;
    });
    expect(receipts.map((receipt) => receipt.targetVersion)).toEqual([
      "2026.9.99-first-hop.0",
      "2026.9.99-first-hop.1",
    ]);
    expect(new Set(receipts.map((receipt) => receipt.targetSha256)).size).toBe(2);
    expect(receipts[1]?.sourceSha256).toBe(receipts[0]?.targetSha256);
    expect(fs.readFileSync(candidate)).toEqual(original);
    expect(() => packFutureUpdateFixture(candidate, candidate)).toThrow("new tarball path");
    expect(fs.readFileSync(candidate)).toEqual(original);
  });

  it.each([0, 1])(
    "packs the runtime plugin in future cohort %s without changing its payload",
    (sequence) => {
      const root = tempDirs.make("openclaw-runtime-cohort-");
      const manifest = {
        name: "@openclaw/codex",
        version: "2026.9.3",
        dependencies: { "@openai/codex": "0.153.4" },
        openclaw: {
          extensions: ["./dist/index.js"],
          compat: { pluginApi: ">=2026.9.3" },
          build: { openclawVersion: "2026.9.3", bundledDist: true },
        },
      };
      writeJson(path.join(root, "package", "package.json"), manifest);
      writeJson(path.join(root, "package", "openclaw.plugin.json"), {
        id: "codex",
        configSchema: { type: "object" },
      });
      fs.mkdirSync(path.join(root, "package", "dist"));
      fs.writeFileSync(
        path.join(root, "package", "dist", "index.js"),
        "export const runtime = 'unchanged';\n",
      );
      const source = path.join(root, "source.tgz");
      const output = path.join(root, "future.tgz");
      execFileSync("tar", ["-czf", source, "-C", root, "package"]);
      const before = fs.readFileSync(source);
      const result = spawnSync(
        process.execPath,
        [
          "scripts/e2e/lib/update-first-hop-package-fixtures.mjs",
          "future-runtime-tarball",
          source,
          output,
          String(sequence),
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      const receipt = JSON.parse(result.stdout);
      const targetVersion = `2026.9.99-first-hop.${sequence}`;
      expect(receipt).toMatchObject({
        method: "candidate-same-schema-runtime-fixture",
        name: "@openclaw/codex",
        sourceVersion: "2026.9.3",
        targetVersion,
      });
      const readEntry = (archive: string, entry: string) =>
        execFileSync("tar", ["-xOf", archive, entry]);
      expect(JSON.parse(readEntry(output, "package/package.json").toString())).toEqual({
        ...manifest,
        version: targetVersion,
        openclaw: {
          ...manifest.openclaw,
          build: { ...manifest.openclaw.build, openclawVersion: targetVersion },
        },
      });
      for (const entry of ["package/dist/index.js", "package/openclaw.plugin.json"]) {
        expect(readEntry(output, entry)).toEqual(readEntry(source, entry));
      }
      expect(fs.readFileSync(source)).toEqual(before);
      expect(receipt.sourceSha256).toBe(createHash("sha256").update(before).digest("hex"));
      expect(receipt.targetSha256).toBe(
        createHash("sha256").update(fs.readFileSync(output)).digest("hex"),
      );
      expect(receipt.targetSha256).not.toBe(receipt.sourceSha256);
    },
  );

  it.each([
    {
      name: "other package",
      packageName: "@openclaw/other",
      version: "2026.9.3",
      buildVersion: "2026.9.3",
      sequence: "0",
    },
    {
      name: "mismatched build",
      packageName: "@openclaw/codex",
      version: "2026.9.3",
      buildVersion: "2026.9.2",
      sequence: "0",
    },
    {
      name: "missing build",
      packageName: "@openclaw/codex",
      version: "2026.9.3",
      buildVersion: undefined,
      sequence: "0",
    },
    {
      name: "invalid version",
      packageName: "@openclaw/codex",
      version: "latest",
      buildVersion: "latest",
      sequence: "0",
    },
    {
      name: "invalid sequence",
      packageName: "@openclaw/codex",
      version: "2026.9.3",
      buildVersion: "2026.9.3",
      sequence: "10",
    },
  ])(
    "rejects runtime fixture $name before creating an output",
    ({ packageName, version, buildVersion, sequence }) => {
      const root = tempDirs.make("openclaw-runtime-cohort-rejected-");
      writeJson(path.join(root, "package", "package.json"), {
        name: packageName,
        version,
        openclaw: { build: { openclawVersion: buildVersion } },
      });
      const source = path.join(root, "source.tgz");
      const output = path.join(root, "future.tgz");
      execFileSync("tar", ["-czf", source, "-C", root, "package"]);
      const before = fs.readFileSync(source);
      const result = spawnSync(
        process.execPath,
        [
          "scripts/e2e/lib/update-first-hop-package-fixtures.mjs",
          "future-runtime-tarball",
          source,
          output,
          sequence,
        ],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(fs.existsSync(output)).toBe(false);
      expect(fs.readFileSync(source)).toEqual(before);
    },
  );

  it.skipIf(process.platform === "win32").each(["explicit", "recorded"])(
    "carries the candidate registry into the first-hop Docker lane with %s sources",
    (sourceMode) => {
      const root = fs.realpathSync(tempDirs.make("openclaw-first-hop-docker-"));
      const bin = path.join(root, "bin");
      const registry = path.join(root, "registry");
      const dockerArgs = path.join(root, "docker-args.json");
      const tarball = path.join(root, "candidate.tgz");
      fs.mkdirSync(bin);
      fs.cpSync(makePackageFixture(), path.join(root, "package"), { recursive: true });
      const sourceTarballs: Record<string, string> = {};
      if (sourceMode === "recorded") {
        const releases = ["2026.9.1", "2026.9.2", "2026.9.3"].map((version) => {
          const sourceRoot = path.join(root, version);
          writeJson(path.join(sourceRoot, "package/package.json"), { name: "openclaw", version });
          writeJson(path.join(sourceRoot, "package/dist/build-info.json"), { version });
          const sourceTarball = path.join(root, `openclaw-${version}.tgz`);
          execFileSync("tar", ["-czf", sourceTarball, "-C", sourceRoot, "package"]);
          sourceTarballs[version] = sourceTarball;
          return {
            version,
            integrity: `sha512-${createHash("sha512").update(fs.readFileSync(sourceTarball)).digest("base64")}`,
            chunks: [],
          };
        });
        writeJson(path.join(root, "package/dist/update-compat-inventory.json"), { releases });
      }
      execFileSync("tar", ["-czf", tarball, "-C", root, "package"]);
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
  const source = JSON.parse(fs.readFileSync(path.join(artifact, "source.json"), "utf8"));
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
process.stdout.write(JSON.stringify([{ filename }]));
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
          OPENCLAW_UPDATE_FIRST_HOP_E2E_SKIP_BUILD: "1",
          OPENCLAW_UPDATE_FIRST_HOP_SOURCE_PACKAGE_TGZ: sourceMode === "explicit" ? tarball : "",
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
      expect(invocations).toHaveLength(sourceMode === "explicit" ? 1 : 3);
      const firstFixture = JSON.parse(
        fs.readFileSync(path.join(root, "artifacts/first-hop-fixture.json"), "utf8"),
      );
      const negativeFixture = JSON.parse(
        fs.readFileSync(path.join(root, "artifacts/negative-fixture.json"), "utf8"),
      );
      const secondFixture = JSON.parse(
        fs.readFileSync(path.join(root, "artifacts/second-hop-fixture.json"), "utf8"),
      );
      expect(firstFixture.sourceSha256).toBe(
        createHash("sha256").update(fs.readFileSync(tarball)).digest("hex"),
      );
      expect(firstFixture.members.changes.map((entry: { path: string }) => entry.path)).toEqual([
        "dist/build-info.json",
        "package.json",
      ]);
      expect(negativeFixture.sourceSha256).toBe(firstFixture.targetSha256);
      expect(secondFixture.sourceSha256).toBe(firstFixture.targetSha256);
      expect(negativeFixture.sourceVersion).toBe(negativeFixture.targetVersion);
      const recorded = JSON.parse(
        fs.readFileSync(path.join(root, "artifacts/summary.json"), "utf8"),
      );
      const packages = sourceMode === "recorded" ? recorded.sources : [recorded];
      for (const artifact of packages) {
        expect(artifact.candidate.version).toBe("2026.9.99-first-hop.0");
        expect(artifact.negative.version).toBe("2026.9.99-first-hop.0");
        expect(artifact.future.version).toBe("2026.9.99-first-hop.1");
        expect(artifact.original.version).toBe("2026.8.1");
        for (const bridge of LEGACY_UPDATE_COMPAT_CHUNKS) {
          expect(artifact.candidate.entries).toContain(`package/dist/${bridge}`);
          expect(artifact.negative.entries).not.toContain(`package/dist/${bridge}`);
          expect(artifact.future.entries).not.toContain(`package/dist/${bridge}`);
        }
      }
      for (const args of invocations) {
        expect(args[args.indexOf("--entrypoint") + 1]).toBe(
          "/opt/openclaw-e2e/scripts/e2e/lib/prepublish-plugin-registry.sh",
        );
        expect(args).toContain(`${registry}:/tmp/openclaw-prepublish-plugin-registry:ro`);
        expect(args).toContain(`${tarball}:/tmp/openclaw-update-first-hop-original.tgz:ro`);
        expect(args).toContain("OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION=2026.8.1");
        expect(args).toContain("bash");
        expect(args).toContain("scripts/e2e/lib/upgrade-survivor/update-first-hop-compat.sh");
      }
      if (sourceMode === "recorded") {
        const summary = JSON.parse(
          fs.readFileSync(path.join(root, "artifacts/summary.json"), "utf8"),
        );
        expect(
          summary.sources.map((entry: { source: { version: string } }) => entry.source.version),
        ).toEqual(["2026.9.1", "2026.9.2", "2026.9.3"]);
        expect(
          invocations.every((args) =>
            args.includes("OPENCLAW_UPDATE_FIRST_HOP_EXPECTED_MISSING_CHUNK="),
          ),
        ).toBe(true);
      }
    },
  );
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
  it("rejects a schema beyond the expected content version", () => {
    const { root, run } = makeTransitionEvidenceFixture();
    fs.mkdirSync(path.join(root, "state"));
    const database = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"));
    database.exec("PRAGMA user_version = 15");
    expect(run("schema", "15").status).toBe(0);
    database.exec("PRAGMA user_version = 16");
    database.close();
    const changed = run("schema", "15");
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain("shared schema changed");
  });

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

  it.each(["17", '"16"', "-1", "null"])("rejects unexpected content metadata %s", (value) => {
    const { root, run } = makeTransitionEvidenceFixture();
    fs.mkdirSync(path.join(root, "state"));
    const database = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"));
    database.exec(
      "PRAGMA user_version = 15; CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT)",
    );
    database
      .prepare("INSERT INTO config_machine_state VALUES (?, ?)")
      .run("state.schema.contentVersion", value);
    database.close();
    expect(run("schema", "15").status).toBe(1);
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

  it("requires both persisted user and assistant messages", () => {
    const { run, file } = makeTransitionEvidenceFixture();
    const user = { role: "user", content: "Return marker RETAINED" };
    const missing = run("history", file("missing.json", { messages: [user] }), "RETAINED");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("durable assistant message");
    const retained = run(
      "history",
      file("retained.json", {
        messages: [user, { role: "assistant", content: [{ type: "text", text: "RETAINED" }] }],
      }),
      "RETAINED",
    );
    expect(retained.status).toBe(0);
  });

  it("refuses an ambiguous retained session identity", () => {
    const { run, file } = makeTransitionEvidenceFixture();
    const result = run(
      "session-key",
      file("sessions.json", {
        sessions: [
          { key: "first", sessionId: "retained" },
          { key: "second", sessionId: "retained" },
        ],
      }),
      "retained",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("expected one retained session identity");
  });
});
