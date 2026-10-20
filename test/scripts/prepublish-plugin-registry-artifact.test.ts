import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as packageArtifact from "../../scripts/e2e/parallels/package-artifact.ts";
import { packAndServeSmokeArtifact } from "../../scripts/e2e/parallels/smoke-common.ts";
import {
  bindCrossOsCandidateRootPackage,
  omitCrossOsCandidateRootPackage,
  resolveCrossOsPackageSet,
  resolveCrossOsRegistryDistTags,
  startCrossOsPackageRegistry,
} from "../../scripts/lib/cross-os-release-checks/companions.ts";
import {
  findLaneByName,
  requiredPrepublishPluginPackagesForLanes,
} from "../../scripts/lib/docker-e2e-plan.mts";
import { resolveNpmJsonString } from "../../scripts/lib/npm-json-output.mts";
import { resolveNpmRunner } from "../../scripts/npm-runner.mts";
import {
  PREPUBLISH_PLUGIN_REGISTRY_MANIFEST,
  createPrepublishPluginRegistryArtifact,
  validatePrepublishPluginRegistryArtifact,
} from "../../scripts/prepublish-plugin-registry-artifact.mjs";
import { resolveExtendedStablePackage } from "../../src/infra/update-check.ts";
import { listenLoopback, respondJson } from "../helpers/gateway-integration-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeCombinedBuildFixture } from "./prepublish-plugin-registry-build.fixture.js";

const SOURCE_SHA = "a".repeat(40);
const VERSION = "2026.8.1-beta.1";
const PACKAGE_NAME = "@openclaw/discord";
const SCRIPT = path.resolve("scripts/prepublish-plugin-registry-artifact.mjs");
const BUILD_AND_PACK = path.resolve("scripts/lib/plugin-npm-build-and-pack.mts");
const registryTempDirs = useAutoCleanupTempDirTracker(afterEach);
const packageTarballs = new Map<string, Buffer>();
const fixtureCommitArgs = [
  "-c",
  "user.email=release-test@example.invalid",
  "-c",
  "user.name=Release Test",
  "-c",
  "commit.gpgsign=false",
  "commit",
  "-m",
  "test: seed release source",
];
const execFileAsync = promisify(execFile);
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const registryPackage = (name: string, version = VERSION, tarballPath = "/tmp/package.tgz") => ({
  name,
  version,
  tarballPath,
});

afterEach(() => {
  vi.restoreAllMocks();
});

function writeJson(file: string, value: unknown) {
  writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function artifactEntry(root: string, artifactDir: string, name: string, tarball: string) {
  const tarballPath = path.join(artifactDir, tarball);
  writeFixtureTarball(root, tarballPath, name);
  return { name, version: VERSION, tarball, sha256: sha256(tarballPath) };
}

function writeFixtureTarball(root: string, tarballPath: string, name: string, version = VERSION) {
  const cacheKey = `${name}@${version}`;
  const cached = packageTarballs.get(cacheKey);
  if (cached) {
    writeFileSync(tarballPath, cached);
    return;
  }
  const packageRoot = path.join(root, "package");
  mkdirSync(packageRoot, { recursive: true });
  writeJson(path.join(packageRoot, "package.json"), { name, version });
  execFileSync("tar", ["-czf", tarballPath, "-C", root, "package"]);
  // Each test mutates its own file; only original archive bytes survive cleanup.
  packageTarballs.set(cacheKey, readFileSync(tarballPath));
}

function fixture(packageNames = [PACKAGE_NAME]) {
  const root = registryTempDirs.make("openclaw-prepublish-plugin-registry-");
  const artifactDir = path.join(root, "artifact");
  mkdirSync(artifactDir);
  const manifestPath = path.join(artifactDir, PREPUBLISH_PLUGIN_REGISTRY_MANIFEST);
  const manifest = {
    schema: "openclaw.prepublish-plugin-registry/v1",
    schemaVersion: 1,
    sourceSha: SOURCE_SHA,
    candidateVersion: VERSION,
    packages: packageNames.map((name) =>
      artifactEntry(
        root,
        artifactDir,
        name,
        `${name.replace(/^@/u, "").replace("/", "-")}-${VERSION}.tgz`,
      ),
    ),
  };
  const writeManifest = () => writeJson(manifestPath, manifest);
  writeManifest();
  return {
    artifactDir,
    manifest,
    manifestPath,
    tarballPath: path.join(artifactDir, manifest.packages[0]!.tarball),
    writeManifest,
  };
}

function immutableTuple(paths: ReturnType<typeof fixture>) {
  return {
    artifactDir: paths.artifactDir,
    expectedCandidateVersion: VERSION,
    expectedManifestSha256: sha256(paths.manifestPath),
    expectedSourceSha: SOURCE_SHA,
    requiredPackages: [PACKAGE_NAME],
  };
}

function validate(paths: ReturnType<typeof fixture>, overrides = {}) {
  return validatePrepublishPluginRegistryArtifact({ ...immutableTuple(paths), ...overrides });
}

function crossOsTuple(paths: ReturnType<typeof fixture>) {
  const { expectedCandidateVersion, expectedManifestSha256, expectedSourceSha, ...rest } =
    immutableTuple(paths);
  return {
    ...rest,
    candidateVersion: expectedCandidateVersion,
    manifestSha256: expectedManifestSha256,
    sourceSha: expectedSourceSha,
  };
}

function cliFixture(packageNames = [PACKAGE_NAME], combinedBuild = false) {
  const repoRoot = registryTempDirs.make("openclaw-prepublish-plugin-cli-");
  const scriptsDir = path.join(repoRoot, "scripts", "lib");
  mkdirSync(scriptsDir, { recursive: true });
  writeJson(path.join(repoRoot, "package.json"), { name: "openclaw", version: VERSION });
  for (const name of packageNames) {
    const packageDir = path.join(repoRoot, "extensions", name.split("/")[1]!);
    mkdirSync(packageDir, { recursive: true });
    writeJson(path.join(packageDir, "package.json"), {
      name,
      version: VERSION,
      openclaw: { release: { publishToNpm: true } },
    });
  }
  writeFileSync(
    path.join(scriptsDir, "plugin-npm-runtime-build.mjs"),
    'console.log("runtime build stdout");\n',
  );
  writeFileSync(
    path.join(scriptsDir, "plugin-npm-package-manifest.mjs"),
    `import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const repoRoot = process.cwd();
const packageDir = process.argv[process.argv.indexOf("--run") + 1];
const outputDir = process.argv[process.argv.indexOf("--pack-destination") + 1];
const staging = path.join(repoRoot, ".pack-fixture");
fs.mkdirSync(path.join(staging, "package"), { recursive: true });
fs.copyFileSync(path.join(repoRoot, packageDir, "package.json"), path.join(staging, "package", "package.json"));
const pkg = JSON.parse(fs.readFileSync(path.join(staging, "package", "package.json"), "utf8"));
const tarball = pkg.name.slice(1).replace("/", "-") + "-" + pkg.version + ".tgz";
execFileSync("tar", ["-czf", path.join(outputDir, tarball), "-C", staging, "package"]);
console.log("package manifest stdout");
`,
  );
  if (combinedBuild) {
    writeCombinedBuildFixture(repoRoot, packageNames, VERSION);
  }
  execFileSync("git", ["init"], { cwd: repoRoot });
  execFileSync("git", ["add", "."], { cwd: repoRoot });
  execFileSync("git", fixtureCommitArgs, { cwd: repoRoot });
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  return { repoRoot, sourceSha };
}

function sourceMetadata(packageDir: string) {
  return ["package.json", "openclaw.plugin.json"].map((file) =>
    readFileSync(path.join(packageDir, file), "utf8"),
  );
}

function createRegistry(
  source: ReturnType<typeof cliFixture>,
  overrides: Partial<Parameters<typeof createPrepublishPluginRegistryArtifact>[0]> = {},
) {
  return createPrepublishPluginRegistryArtifact({
    ...source,
    outputDir: path.join(source.repoRoot, "artifact"),
    candidateVersion: VERSION,
    requiredPackages: [PACKAGE_NAME],
    ...overrides,
  });
}

function preparedBundleFixture(repoRoot: string, sourceSha: string) {
  const preparedBundleDir = path.join(repoRoot, "prepared-bundle");
  mkdirSync(preparedBundleDir);
  const entries = ["openclaw", "@openclaw/ai", "@openclaw/gateway-protocol"].map((name) => {
    const tarballName = `${name.replace(/^@/u, "").replace("/", "-")}.tgz`;
    const tarballPath = path.join(preparedBundleDir, tarballName);
    writeFixtureTarball(path.join(repoRoot, "prepared-staging"), tarballPath, name);
    return {
      packageName: name,
      packageVersion: VERSION,
      tarballName,
      tarballSha256: sha256(tarballPath),
    };
  });
  const bundle = {
    schema: "openclaw.npm-package-bundle/v1",
    releaseSha: sourceSha,
    ...entries[0],
    corePackageTarballs: entries.slice(1),
    dependencyTarballs: [entries[1]],
  };
  const writeBundle = () => writeJson(path.join(preparedBundleDir, "package-bundle.json"), bundle);
  writeBundle();
  return { preparedBundleDir, bundle, entries, writeBundle };
}

describe("prepublish plugin registry artifact", () => {
  it("packages the built runtime and restores source metadata in one child", async () => {
    const { repoRoot, sourceSha } = cliFixture([PACKAGE_NAME], true);
    const packageDir = path.join(repoRoot, "extensions", "discord");
    const original = sourceMetadata(packageDir);
    const artifactDir = path.join(repoRoot, "artifact");
    const result = createRegistry({ repoRoot, sourceSha });
    const tarball = path.join(artifactDir, result.manifest.packages[0]!.tarball);
    const packedPackage = JSON.parse(
      execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }),
    );
    expect(packedPackage.openclaw.runtimeExtensions).toEqual(["./dist/index.js"]);
    const runtime = execFileSync("tar", ["-xOf", tarball, "package/dist/index.js"]);
    const loaded = await import(`data:text/javascript;base64,${runtime.toString("base64")}`);
    expect(loaded.message).toBe("built before packing");
    expect(sourceMetadata(packageDir)).toEqual(original);
  });

  it.each(["build", "pack"])(
    "does not publish after a %s failure and restores source metadata",
    (failure) => {
      const { repoRoot } = cliFixture([PACKAGE_NAME], true);
      const packageDir = path.join(repoRoot, "extensions", "discord");
      const outputDir = path.join(repoRoot, "artifact");
      mkdirSync(outputDir);
      if (failure === "build") {
        writeFileSync(
          path.join(packageDir, "index.ts"),
          'export { missing } from "./missing.ts";\n',
        );
      }
      const original = sourceMetadata(packageDir);
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "./scripts/tsx.mjs",
          BUILD_AND_PACK,
          packageDir,
          failure === "pack" ? path.join(outputDir, "missing") : outputDir,
        ],
        { cwd: repoRoot, encoding: "utf8" },
      );
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stderr).toContain(failure === "build" ? "missing.ts" : "ENOENT");
      expect(existsSync(path.join(packageDir, "dist/index.js"))).toBe(failure === "pack");
      expect(readdirSync(outputDir)).toEqual([]);
      expect(sourceMetadata(packageDir)).toEqual(original);
    },
  );

  it.each([
    ["source", "bundle identity differs"],
    ["conflicting dependency", "conflicting package"],
    ["tarball bytes", "tarball SHA-256 mismatch"],
  ])("rejects prepared bundle %s drift before accepting its registry", (drift, error) => {
    const { repoRoot, sourceSha } = cliFixture([]);
    const { preparedBundleDir, bundle, entries, writeBundle } = preparedBundleFixture(
      repoRoot,
      sourceSha,
    );
    if (drift === "source") {
      bundle.releaseSha = "b".repeat(40);
    }
    if (drift === "conflicting dependency") {
      bundle.dependencyTarballs = [{ ...entries[1]!, tarballSha256: "c".repeat(64) }];
    }
    if (drift === "tarball bytes") {
      writeFileSync(path.join(preparedBundleDir, entries[1]!.tarballName), "tampered");
    }
    writeBundle();

    expect(() =>
      createRegistry({ repoRoot, sourceSha }, { requiredPackages: [], preparedBundleDir }),
    ).toThrow(error);
  });

  it("stages the planned slack candidate and Codex in one verified artifact", () => {
    const lane = findLaneByName("npm-onboard-slack-candidate-channel-agent");
    expect(lane).toBeDefined();
    const requiredPackages = requiredPrepublishPluginPackagesForLanes([lane!]);
    const expectedPackages = ["@openclaw/codex", "@openclaw/slack"];
    const { repoRoot, sourceSha } = cliFixture(expectedPackages);
    const artifactDir = path.join(repoRoot, "artifact");
    const result = createRegistry({ repoRoot, sourceSha }, { requiredPackages });
    const verified = validatePrepublishPluginRegistryArtifact({
      artifactDir,
      expectedSourceSha: sourceSha,
      expectedCandidateVersion: VERSION,
      expectedManifestSha256: result.manifestSha256,
      requiredPackages: expectedPackages,
    });
    expect(verified.manifest.packages.map(({ name, version }) => ({ name, version }))).toEqual(
      expectedPackages.map((name) => ({ name, version: VERSION })),
    );
  });

  it("can be imported from stdin without running the CLI", () => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
      input: `import { PREPUBLISH_PLUGIN_REGISTRY_MANIFEST } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};\nconsole.log(PREPUBLISH_PLUGIN_REGISTRY_MANIFEST);\n`,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${PREPUBLISH_PLUGIN_REGISTRY_MANIFEST}\n`);
  });

  it.runIf(process.platform !== "win32")(
    "serves a Parallels candidate with its companion packages and closes both endpoints",
    async () => {
      const core = fixture(["openclaw"]);
      const companion = fixture();
      vi.spyOn(packageArtifact, "packOpenClaw").mockResolvedValue({
        path: core.tarballPath,
        version: VERSION,
        registryPackages: [
          { name: PACKAGE_NAME, version: VERSION, tarballPath: companion.tarballPath },
        ],
      });
      const [, server] = await packAndServeSmokeArtifact(
        core.artifactDir,
        undefined,
        "127.0.0.1",
        0,
        "candidate fixture",
        false,
        "openai",
      );
      const staticUrl = server.urlFor(core.tarballPath);
      let registryUrl = "";
      try {
        expect(server.registry).toBeDefined();
        registryUrl = server.registry!.url;
        for (const [name, tarball] of [
          ["openclaw", core.tarballPath],
          [PACKAGE_NAME, companion.tarballPath],
        ] as const) {
          const response = await fetch(`${registryUrl}/${encodeURIComponent(name)}`);
          const metadata = await response.json();
          expect(metadata.versions[VERSION]).toMatchObject({ name, version: VERSION });
          const packed = await fetch(metadata.versions[VERSION].dist.tarball);
          expect(Buffer.from(await packed.arrayBuffer())).toEqual(readFileSync(tarball));
        }
        expect(Buffer.from(await (await fetch(staticUrl)).arrayBuffer())).toEqual(
          readFileSync(core.tarballPath),
        );
      } finally {
        await server.stop();
      }
      for (const url of [staticUrl, registryUrl]) {
        await expect(fetch(url, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
      }
    },
  );

  it("requires the complete immutable identity tuple", () => {
    const paths = fixture();
    const common = immutableTuple(paths);
    for (const field of [
      "expectedCandidateVersion",
      "expectedManifestSha256",
      "expectedSourceSha",
    ] as const) {
      expect(() =>
        validatePrepublishPluginRegistryArtifact({ ...common, [field]: undefined }),
      ).toThrow(field);
    }
  });

  it("extracts only required cross-OS companions from the validated registry", () => {
    const paths = fixture([PACKAGE_NAME, "@openclaw/feishu"]);

    expect(
      resolveCrossOsPackageSet({ ...crossOsTuple(paths), requiredPackages: ["@openclaw/feishu"] })
        .companions,
    ).toEqual([
      {
        name: "@openclaw/feishu",
        tarballPath: path.join(paths.artifactDir, "openclaw-feishu-2026.8.1-beta.1.tgz"),
      },
    ]);
  });

  it("publishes the candidate root under the extended-stable registry tag", () => {
    const tagged = (version: string) =>
      resolveCrossOsRegistryDistTags([registryPackage("openclaw", version)]);
    expect(tagged("2026.8.34")).toBe("extended-stable=2026.8.34");
    expect(tagged("2026.9.1")).toBeUndefined();
    const codex = registryPackage("@openclaw/codex", "2026.9.1", "/tmp/codex.tgz");
    expect(
      omitCrossOsCandidateRootPackage([codex, registryPackage("openclaw", "2026.9.1")]),
    ).toEqual([codex]);
  });

  it("keeps the shipped updater and npm install on the local extended-stable candidate", async () => {
    const candidateVersion = "2026.8.34";
    const publishedVersion = "2026.8.33";
    const root = registryTempDirs.make("openclaw-cross-os-registry-");
    const tarballPath = path.join(root, `openclaw-${candidateVersion}.tgz`);
    writeFixtureTarball(path.join(root, "archive"), tarballPath, "openclaw", candidateVersion);

    const upstreamRequests: string[] = [];
    const upstream = createServer((request, response) => {
      upstreamRequests.push(request.url ?? "");
      if (request.url !== "/openclaw") {
        response.writeHead(404).end();
        return;
      }
      respondJson(response, {
        name: "openclaw",
        "dist-tags": { latest: publishedVersion },
        versions: {
          [publishedVersion]: {
            name: "openclaw",
            version: publishedVersion,
            dist: { tarball: `${upstreamUrl}/openclaw/-/openclaw-${publishedVersion}.tgz` },
          },
        },
      });
    });
    const upstreamUrl = await listenLoopback(upstream);
    let registry: Awaited<ReturnType<typeof startCrossOsPackageRegistry>>;
    try {
      const packages = bindCrossOsCandidateRootPackage([], {
        version: candidateVersion,
        tarballPath,
      });
      expect(resolveCrossOsRegistryDistTags(packages)).toBe(`extended-stable=${candidateVersion}`);
      registry = await startCrossOsPackageRegistry(packages, root, {
        upstreamRegistry: upstreamUrl,
      });
      expect(registry).toBeDefined();
      const registryUrl = registry!.url;
      const env = {
        ...process.env,
        NPM_CONFIG_AUDIT: "false",
        NPM_CONFIG_CACHE: path.join(root, "npm-cache"),
        NPM_CONFIG_FUND: "false",
        NPM_CONFIG_REGISTRY: registryUrl,
        NPM_CONFIG_TAG: "extended-stable",
        OPENCLAW_UPDATE_PACKAGE_SPEC: "openclaw",
      };
      const runNpm = async (npmArgs: string[]) => {
        const runner = resolveNpmRunner({ env, npmArgs });
        return await execFileAsync(runner.command, runner.args, {
          encoding: "utf8",
          env: runner.env ?? env,
          timeout: 10_000,
          windowsVerbatimArguments: runner.windowsVerbatimArguments,
        });
      };
      await expect(
        fetch(`${registryUrl}/openclaw/latest`).then(async (response) => await response.json()),
      ).resolves.toMatchObject({ name: "openclaw", version: publishedVersion });
      await expect(
        resolveExtendedStablePackage({ installKind: "package", env, timeoutMs: 5_000 }),
      ).resolves.toMatchObject({
        status: "resolved",
        selector: "extended-stable",
        version: candidateVersion,
        packageSpec: `openclaw@${candidateVersion}`,
      });

      const viewedVersion = resolveNpmJsonString(
        JSON.parse((await runNpm(["view", "openclaw", "version", "--json"])).stdout),
      );
      expect(viewedVersion).toBe(candidateVersion);

      const installPrefix = path.join(root, "installed");
      await runNpm([
        "install",
        "--ignore-scripts",
        "--no-package-lock",
        "--prefix",
        installPrefix,
        "openclaw",
      ]);
      expect(readJson(path.join(installPrefix, "node_modules/openclaw/package.json")).version).toBe(
        candidateVersion,
      );
      expect(upstreamRequests).not.toContain("/openclaw/extended-stable");
      expect(upstreamRequests).not.toContain(`/openclaw/${candidateVersion}`);
    } finally {
      try {
        await registry?.close();
      } finally {
        await new Promise<void>((resolveClose, rejectClose) => {
          upstream.close((error) => (error ? rejectClose(error) : resolveClose()));
        });
      }
    }
  }, 30_000);

  it("rejects mismatched cross-OS companion registry identities", () => {
    const paths = fixture();
    const common = crossOsTuple(paths);

    for (const [field, value, error] of [
      ["sourceSha", "b".repeat(40), "source SHA differs"],
      ["candidateVersion", "2026.8.1-beta.2", "version differs"],
      ["manifestSha256", "c".repeat(64), "manifest SHA-256 differs"],
    ] as const) {
      expect(() => resolveCrossOsPackageSet({ ...common, [field]: value })).toThrow(error);
    }

    writeFileSync(paths.tarballPath, "tampered");
    expect(() => resolveCrossOsPackageSet(common)).toThrow("tarball SHA-256 mismatch");
  });

  it("refuses to create an artifact from tracked changes under the same HEAD", () => {
    const { repoRoot, sourceSha } = cliFixture([]);
    writeJson(path.join(repoRoot, "package.json"), {
      name: "openclaw",
      version: `${VERSION}-dirty`,
    });

    expect(() => createRegistry({ repoRoot, sourceSha }, { requiredPackages: [] })).toThrow(
      "tracked changes",
    );
  });

  it("rejects traversal and duplicate package entries", () => {
    const traversal = fixture();
    traversal.manifest.packages[0]!.tarball = "../escape.tgz";
    traversal.writeManifest();
    expect(() => validate(traversal)).toThrow("invalid package entry");

    const duplicate = fixture();
    duplicate.manifest.packages.push({ ...duplicate.manifest.packages[0]! });
    duplicate.writeManifest();
    expect(() =>
      validate(duplicate, { requiredPackages: [PACKAGE_NAME, "@openclaw/feishu"] }),
    ).toThrow("duplicate package");
  });

  it("rejects missing and extra artifact files", () => {
    const missing = fixture();
    unlinkSync(missing.tarballPath);
    expect(() => validate(missing)).toThrow("missing, extra, or non-file");

    const extra = fixture();
    writeFileSync(path.join(extra.artifactDir, "extra.txt"), "unexpected");
    expect(() => validate(extra)).toThrow("missing, extra, or non-file");
  });

  it("rejects package identity and required-set mismatches", () => {
    const identity = fixture();
    identity.manifest.packages[0]!.name = "@openclaw/feishu";
    identity.writeManifest();
    expect(() => validate(identity, { requiredPackages: ["@openclaw/feishu"] })).toThrow(
      "tarball identity mismatch",
    );

    const required = fixture();
    expect(() => validate(required, { requiredPackages: ["@openclaw/feishu"] })).toThrow(
      "missing Docker-plan package",
    );
  });
});
