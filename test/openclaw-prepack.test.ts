// OpenClaw prepack tests validate package prepack output.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readlinkSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { pnpmLockfileDocuments } from "../scripts/lib/pnpm-lockfile-documents.mjs";
import { restorePrepackArtifacts } from "../scripts/openclaw-postpack.mjs";
import {
  collectSourcePackWorkspaceDependencyErrors,
  resolvePrepackCommandStdio,
  runPrepackCommand,
} from "../scripts/openclaw-prepack.ts";
import { preparePackageDocsMap } from "../scripts/package-docs-map.mjs";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../src/infra/runtime-worker-url.js";
import { WORKER_BUNDLE_ARTIFACT_PATHS } from "../src/shared/worker-bundle-hash.js";
import { resolveTestNodeExecPath } from "../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";
import { toolingTsEntrypoints } from "./scripts/tooling-ts-runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const testNodeExecPath = resolveTestNodeExecPath();
const rootPackageManager = (
  JSON.parse(readFileSync("package.json", "utf8")) as {
    packageManager: string;
  }
).packageManager;
const rootPnpmEnvironment = pnpmLockfileDocuments(
  readFileSync("pnpm-lock.yaml", "utf8"),
).environment;
if (!rootPnpmEnvironment) {
  throw new Error("pnpm-lock.yaml is missing its environment document");
}

const standaloneBundledChannelSmokeFiles = [
  "scripts/test-built-bundled-channel-entry-smoke.mts",
  "scripts/lib/bundled-plugin-build-entries.mjs",
  "scripts/lib/bundled-plugin-paths.mjs",
  "scripts/lib/optional-bundled-clusters.mjs",
  "scripts/lib/package-root-args.mts",
  "scripts/lib/record-shared.mjs",
  "scripts/lib/root-package-bundled-plugin-excludes.mjs",
  "scripts/process-warning-filter.mts",
  "src/shared/non-packaged-plugin-dirs.ts",
];

function linkFixtureParent(packageRoot: string) {
  const nodeModulesRoot = path.join(packageRoot, "node_modules");
  const parentRoot = path.join(
    nodeModulesRoot,
    ".pnpm",
    "fixture-parent@1.0.0",
    "node_modules",
    "fixture-parent",
  );
  symlinkSync(
    process.platform === "win32" ? parentRoot : path.relative(nodeModulesRoot, parentRoot),
    path.join(nodeModulesRoot, "fixture-parent"),
    process.platform === "win32" ? "junction" : "dir",
  );
}

function createBundledChannelSmokeFixture(
  entrySource: string,
  options: { prepared?: boolean } = {},
) {
  const rootDir = tempDirs.make("openclaw-prepack-standalone-smoke-");
  for (const relativePath of standaloneBundledChannelSmokeFiles) {
    const destination = path.join(rootDir, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(process.cwd(), relativePath), destination);
  }

  const packageRoot = options.prepared ? rootDir : path.join(rootDir, "package");
  const extensionRoot = path.join(packageRoot, "dist", "extensions", "fixture-channel");
  mkdirSync(extensionRoot, { recursive: true });
  writeFileSync(path.join(packageRoot, "package.json"), '{"files":[]}\n');
  writeFileSync(
    path.join(extensionRoot, "package.json"),
    `${JSON.stringify({
      name: "@openclaw/fixture-channel",
      openclaw: { channel: true, extensions: ["./index.ts"] },
    })}\n`,
  );
  writeFileSync(path.join(extensionRoot, "index.js"), entrySource);

  const nodeModulesRoot = path.join(packageRoot, "node_modules");
  const parentStoreRoot = path.join(
    nodeModulesRoot,
    ".pnpm",
    "fixture-parent@1.0.0",
    "node_modules",
  );
  const parentRoot = path.join(parentStoreRoot, "fixture-parent");
  const siblingRoot = path.join(parentStoreRoot, "fixture-sibling");
  mkdirSync(parentRoot, { recursive: true });
  mkdirSync(siblingRoot);
  writeFileSync(
    path.join(parentRoot, "package.json"),
    '{"name":"fixture-parent","version":"1.0.0","type":"module","exports":"./index.js"}\n',
  );
  writeFileSync(
    path.join(parentRoot, "index.js"),
    'import { value } from "fixture-sibling"; export const fixtureValue = value;\n',
  );
  writeFileSync(
    path.join(siblingRoot, "package.json"),
    '{"name":"fixture-sibling","version":"1.0.0","type":"module","exports":"./index.js"}\n',
  );
  writeFileSync(path.join(siblingRoot, "index.js"), 'export const value = "fixture-channel";\n');
  linkFixtureParent(packageRoot);

  return {
    rootDir,
    packageRoot,
    dependencyFiles: {
      parent: readFileSync(path.join(parentRoot, "index.js"), "utf8"),
      sibling: readFileSync(path.join(siblingRoot, "index.js"), "utf8"),
    },
  };
}

function createPreparedPrepackFixture(entrySource: string) {
  const { rootDir } = createBundledChannelSmokeFixture(entrySource, { prepared: true });
  mkdirSync(path.join(rootDir, "node_modules"), { recursive: true });
  symlinkSync(
    path.dirname(fileURLToPath(import.meta.resolve("tsx/package.json"))),
    path.join(rootDir, "node_modules/tsx"),
    "junction",
  );
  mkdirSync(path.join(rootDir, "docs"));
  mkdirSync(path.join(rootDir, "dist/control-ui/assets"), { recursive: true });
  const workerSourceFiles = Object.fromEntries(
    WORKER_BUNDLE_ARTIFACT_PATHS.map((artifactPath) => [
      `dist/worker/${artifactPath}`,
      "export {};\n",
    ]),
  ) as Record<string, string>;
  const sourceFiles = {
    "package.json": '{"name":"openclaw","version":"2026.8.1","type":"module","files":["dist"]}\n',
    "CHANGELOG.md": "# Changelog\n\n## 2026.8.1\n- Current release notes with enough detail.\n",
    "docs/page.md": "# Package docs\n",
    "dist/index.js": "export {};\n",
    "dist/control-ui/index.html": "<!doctype html>\n",
    "dist/control-ui/assets/fixture.js.br": "prepared asset fixture\n",
    "dist/control-ui/assets/fixture.js.gz": "prepared asset fixture\n",
    ...workerSourceFiles,
  };
  for (const [name, contents] of Object.entries(sourceFiles)) {
    mkdirSync(path.dirname(path.join(rootDir, name)), { recursive: true });
    writeFileSync(path.join(rootDir, name), contents);
  }
  return { rootDir, sourceFiles };
}

function createPrepackLifecycleFixture() {
  const { rootDir, sourceFiles } = createPreparedPrepackFixture(
    'export default { kind: "bundled-channel-entry", loadChannelPlugin() { return { id: "fixture-channel" }; } };\n',
  );
  const packageJson = JSON.parse(sourceFiles["package.json"]);
  Object.assign(packageJson, {
    packageManager: rootPackageManager,
    files: [
      "dist",
      "!dist/worker/**",
      "dist/worker-artifacts/*.tar.gz",
      "docs/docs_map.md",
      "CHANGELOG.md",
      ".openclaw-lifecycle-pending",
    ],
    devDependencies: { "@openclaw/session-url-contract": "workspace:*" },
    scripts: {
      "build:package": "node rebuild.mjs",
      "update:compat:check": "node check-update-compat.mjs",
      prepack: "node lifecycle.mjs prepack",
      postpack: "node lifecycle.mjs postpack",
    },
  });
  sourceFiles["package.json"] = `${JSON.stringify(packageJson, null, 2)}\n`;
  sourceFiles["CHANGELOG.md"] += "\n## 2026.7.1\n- Previous release notes with enough detail.\n";
  writeFileSync(path.join(rootDir, "package.json"), sourceFiles["package.json"]);
  // Without the toolchain lock, pnpm 12 resolves registry metadata before running prepack.
  writeFileSync(
    path.join(rootDir, "pnpm-lock.yaml"),
    `---\n${rootPnpmEnvironment}\n---\nlockfileVersion: '9.0'\nimporters: {}\n`,
  );
  writeFileSync(path.join(rootDir, "CHANGELOG.md"), sourceFiles["CHANGELOG.md"]);
  writeFileSync(path.join(rootDir, "docs/docs_map.md"), "Source docs-map stub.\n");
  writeFileSync(
    path.join(rootDir, "rebuild.mjs"),
    'import { writeFileSync } from "node:fs";\n' +
      'writeFileSync("build-invoked", "build:package\\n");\n' +
      'writeFileSync("dist/index.js", "export const rebuilt = true;\\n");\n',
  );
  writeFileSync(
    path.join(rootDir, "check-update-compat.mjs"),
    'import { existsSync, writeFileSync } from "node:fs";\n' +
      'writeFileSync("compat-check-invoked", "update:compat:check\\n");\n' +
      'if (existsSync("stale-update-compat")) throw new Error("Missing latest updater inventory; run pnpm update:compat:gen");\n',
  );
  writeFileSync(
    path.join(rootDir, "lifecycle.mjs"),
    `import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const ownerArgs = process.argv[2] === "prepack"
  ? ${JSON.stringify(resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(toolingTsEntrypoints.prepack), testNodeExecPath))}
  : [${JSON.stringify(path.resolve("scripts/openclaw-postpack.mjs"))}];
const result = spawnSync(process.execPath, ownerArgs, { encoding: "utf8" });
writeFileSync(process.argv[2] + "-result.json", JSON.stringify({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }));
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
`,
  );
  // pnpm may suppress lifecycle output; observe the actual hook before its reporter.
  const readLifecycleResult = (event: "prepack" | "postpack") =>
    JSON.parse(readFileSync(path.join(rootDir, `${event}-result.json`), "utf8")) as {
      status: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
    };
  const packDir = path.join(rootDir, "pack");
  mkdirSync(packDir);
  const pack = (prepared: boolean) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
    };
    delete env.OPENCLAW_PREPACK_PREPARED;
    if (prepared) {
      env.OPENCLAW_PREPACK_PREPARED = "1";
    }
    return spawnSync("pnpm", ["pack", "--silent", "--pack-destination", packDir], {
      cwd: rootDir,
      encoding: "utf8",
      env,
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  };
  const expectRestored = () => {
    for (const name of ["package.json", "CHANGELOG.md"] as const) {
      expect(readFileSync(path.join(rootDir, name), "utf8")).toBe(sourceFiles[name]);
    }
    expect(readFileSync(path.join(rootDir, "docs/docs_map.md"), "utf8")).toBe(
      "Source docs-map stub.\n",
    );
    for (const name of [
      ".openclaw-lifecycle-pending",
      ".artifacts/package-docs-map/receipt.json",
      ".artifacts/package-manifest/package.json.prepack-backup",
      ".artifacts/package-changelog/CHANGELOG.md.prepack-backup",
    ]) {
      expect(existsSync(path.join(rootDir, name)), name).toBe(false);
    }
  };
  return { rootDir, sourceFiles, packDir, pack, readLifecycleResult, expectRestored };
}

function runStandaloneBundledChannelSmoke(entrySource: string) {
  const { dependencyFiles, rootDir, packageRoot } = createBundledChannelSmokeFixture(entrySource);
  const temporaryRoot = path.join(rootDir, "smoke-temp");
  mkdirSync(temporaryRoot);
  const sentinelPath = path.join(temporaryRoot, "unrelated.txt");
  writeFileSync(sentinelPath, "preserve caller-owned temporary sibling\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: temporaryRoot,
    TMP: temporaryRoot,
    TEMP: temporaryRoot,
  };
  delete env.OPENCLAW_BUNDLED_CHANNEL_SMOKE_INSTALLED_LAYOUT;

  const result = spawnSync(
    testNodeExecPath,
    [
      path.join(rootDir, "scripts", "test-built-bundled-channel-entry-smoke.mts"),
      "--package-root",
      packageRoot,
    ],
    {
      cwd: rootDir,
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return {
    result,
    temporaryEntries: readdirSync(temporaryRoot).toSorted(),
    sentinel: readFileSync(sentinelPath, "utf8"),
    entrySource: readFileSync(
      path.join(packageRoot, "dist", "extensions", "fixture-channel", "index.js"),
      "utf8",
    ),
    dependencyFiles: {
      parent: readFileSync(
        path.join(
          packageRoot,
          "node_modules/.pnpm/fixture-parent@1.0.0/node_modules/fixture-parent/index.js",
        ),
        "utf8",
      ),
      sibling: readFileSync(
        path.join(
          packageRoot,
          "node_modules/.pnpm/fixture-parent@1.0.0/node_modules/fixture-sibling/index.js",
        ),
        "utf8",
      ),
    },
    dependencyLink: {
      target: readlinkSync(path.join(packageRoot, "node_modules/fixture-parent")),
      resolved: realpathSync(path.join(packageRoot, "node_modules/fixture-parent")),
    },
    originalDependencyFiles: dependencyFiles,
  };
}

describe("standalone bundled channel smoke", () => {
  it("preserves the result and releases its layout for source with outcome=valid", () => {
    const entrySource = `
        import assert from "node:assert/strict";
        import { realpathSync } from "node:fs";
        import { fileURLToPath } from "node:url";
        import { fixtureValue } from "fixture-parent";
          const modulePath = realpathSync(fileURLToPath(import.meta.url)).replaceAll("\\\\", "/");
          assert.ok(modulePath.includes("/node_modules/openclaw/dist/"));
        export default { kind: "bundled-channel-entry", loadChannelPlugin() { return { id: fixtureValue }; } };
      `;
    const observed = runStandaloneBundledChannelSmoke(entrySource);
    const { result } = observed;
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("channel=1");
    expect(result.stdout.match(/\[build-smoke\]/gu)).toHaveLength(1);
    expect(observed.entrySource).toBe(entrySource);
    expect(observed.dependencyFiles).toEqual(observed.originalDependencyFiles);
    expect(observed.dependencyLink.target).toContain(".pnpm");
    expect(observed.dependencyLink.resolved).toContain(
      path.join(".pnpm", "fixture-parent@1.0.0", "node_modules", "fixture-parent"),
    );
    expect(observed.sentinel).toBe("preserve caller-owned temporary sibling\n");
    expect(observed.temporaryEntries).toEqual(["unrelated.txt"]);
  });
});

describe("prepared prepack ownership", () => {
  it.each([
    { invalid: false, incumbent: true },
    { invalid: true, incumbent: true },
  ])(
    "does not mutate source when smoke is invalid=$invalid and incumbent=$incumbent",
    async ({ invalid, incumbent }) => {
      const { rootDir, sourceFiles } = createPreparedPrepackFixture(
        invalid
          ? "export default [];\n"
          : 'export default { kind: "bundled-channel-entry", loadChannelPlugin() { return { id: "fixture-channel" }; } };\n',
      );
      if (incumbent) {
        await preparePackageDocsMap(rootDir);
      }
      const receiptPath = path.join(rootDir, ".artifacts/package-docs-map/receipt.json");
      const receipt = incumbent ? readFileSync(receiptPath, "utf8") : undefined;
      const ownerUrl = resolveRuntimeWorkerUrl(toolingTsEntrypoints.prepack);
      const result = spawnSync(
        testNodeExecPath,
        [
          ...resolveRuntimeWorkerArgv(ownerUrl, testNodeExecPath).slice(0, -1),
          "--input-type=module",
          "--eval",
          `import { preparePrepackArtifacts } from ${JSON.stringify(ownerUrl.href)}; await preparePrepackArtifacts();`,
        ],
        {
          cwd: rootDir,
          encoding: "utf8",
          timeout: 30_000,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            // The source smoke fixture retains the package's standalone loader contract.
            TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
          },
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(invalid ? "AssertionError" : "PACKAGE_DOCS_MAP_ACTIVE");
      expect(existsSync(path.join(rootDir, ".openclaw-lifecycle-pending"))).toBe(false);
      expect(existsSync(path.join(rootDir, "dist/postinstall-inventory.json"))).toBe(false);
      for (const [name, contents] of Object.entries(sourceFiles)) {
        expect(readFileSync(path.join(rootDir, name), "utf8")).toBe(contents);
      }
      if (incumbent) {
        expect(readFileSync(receiptPath, "utf8")).toBe(receipt);
        await restorePrepackArtifacts(rootDir);
      }
      expect(existsSync(receiptPath)).toBe(false);
    },
  );
});

describe("prepack lifecycle", () => {
  it("rejects prepared packages with stale updater inventory without rebuilding or leaving source mutations", () => {
    const fixture = createPrepackLifecycleFixture();
    writeFileSync(path.join(fixture.rootDir, "stale-update-compat"), "stale\n");
    const result = fixture.pack(true);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    const prepack = fixture.readLifecycleResult("prepack");
    expect(prepack).toMatchObject({ status: 1, signal: null });
    expect(prepack.stderr).toContain(
      "Missing latest updater inventory; run pnpm update:compat:gen",
    );
    expect(existsSync(path.join(fixture.rootDir, "build-invoked"))).toBe(false);
    expect(readdirSync(fixture.packDir)).toEqual([]);
    fixture.expectRestored();
  });
});

describe("collectSourcePackWorkspaceDependencyErrors", () => {
  it("rejects the plain source pack that pnpm rewrites without bundling @openclaw/ai", () => {
    const rootDir = tempDirs.make("openclaw-source-pack-workspace-");
    const aiDir = path.join(rootDir, "packages", "ai");
    const packDir = path.join(rootDir, "pack");
    const extractDir = path.join(rootDir, "extract");
    const version = "2099.1.2-test.0";
    const rootPackageJson = {
      dependencies: { "@openclaw/ai": "workspace:*" },
      name: "openclaw-source-pack-regression",
      packageManager: rootPackageManager,
      version,
    };
    mkdirSync(aiDir, { recursive: true });
    mkdirSync(packDir);
    mkdirSync(extractDir);
    writeFileSync(
      path.join(rootDir, "package.json"),
      `${JSON.stringify(rootPackageJson, null, 2)}\n`,
    );
    writeFileSync(path.join(rootDir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    writeFileSync(
      path.join(aiDir, "package.json"),
      `${JSON.stringify({ name: "@openclaw/ai", version }, null, 2)}\n`,
    );

    const install = spawnSync("pnpm", ["install", "--ignore-scripts", "--reporter=silent"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(install.status, install.stderr).toBe(0);
    const packed = spawnSync(
      "pnpm",
      ["pack", "--config.ignore-scripts=true", "--json", "--pack-destination", packDir],
      {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(packed.status, packed.stderr).toBe(0);
    const packResult = JSON.parse(packed.stdout) as
      | { filename: string }
      | Array<{
          filename: string;
        }>;
    const filename = Array.isArray(packResult) ? packResult[0]?.filename : packResult.filename;
    expect(filename).toBeTruthy();
    const tarballPath = path.resolve(packDir, path.basename(filename ?? ""));
    tar.x({ cwd: extractDir, file: tarballPath, sync: true });

    const packedPackageJson = JSON.parse(
      readFileSync(path.join(extractDir, "package", "package.json"), "utf8"),
    ) as {
      bundleDependencies?: string[];
      dependencies?: Record<string, string>;
    };
    expect(packedPackageJson.dependencies?.["@openclaw/ai"]).toBe(version);
    expect(packedPackageJson.bundleDependencies).toBeUndefined();
    expect(existsSync(path.join(extractDir, "package", "node_modules", "@openclaw", "ai"))).toBe(
      false,
    );
    expect(existsSync(path.join(extractDir, "package", "npm-shrinkwrap.json"))).toBe(false);
    expect(existsSync(path.join(extractDir, "package", "package-lock.json"))).toBe(false);
    expect(collectSourcePackWorkspaceDependencyErrors(rootPackageJson, {})).toEqual([
      "plain root packing cannot safely resolve @openclaw/ai from workspace:*: pnpm rewrites the workspace dependency to an exact version without bundling the package",
      "use `node scripts/package-openclaw-for-docker.mjs --allow-unreleased-changelog` for a self-contained source package; official npm release automation prepares and publishes @openclaw/ai separately",
    ]);
    expect(
      collectSourcePackWorkspaceDependencyErrors(rootPackageJson, {
        OPENCLAW_PREPACK_PREPARED: "1",
      }),
    ).toEqual([]);
    expect(
      collectSourcePackWorkspaceDependencyErrors(rootPackageJson, {
        npm_command: "pack",
        OCM_INTERNAL_NPM_BIN: path.join(rootDir, "scripts", "ocm-npm-workspace-deps.mts"),
        OPENCLAW_OCM_WORKSPACE_DEPENDENCY_DIRS: aiDir,
      }),
    ).toEqual([]);
    expect(
      collectSourcePackWorkspaceDependencyErrors(rootPackageJson, {
        npm_command: "pack",
        OCM_INTERNAL_NPM_BIN: path.join(rootDir, "scripts", "ocm-npm-workspace-deps.mts"),
        OPENCLAW_OCM_WORKSPACE_DEPENDENCY_DIRS: rootDir,
      }),
    ).toHaveLength(2);
    expect(
      collectSourcePackWorkspaceDependencyErrors(rootPackageJson, {
        npm_command: "pack",
        OCM_INTERNAL_NPM_BIN: path.join(rootDir, "scripts", "other-npm-wrapper.mjs"),
        OPENCLAW_OCM_WORKSPACE_DEPENDENCY_DIRS: aiDir,
      }),
    ).toHaveLength(2);
    expect(
      collectSourcePackWorkspaceDependencyErrors(rootPackageJson, {
        npm_command: "publish",
        OCM_INTERNAL_NPM_BIN: path.join(rootDir, "scripts", "ocm-npm-workspace-deps.mts"),
        OPENCLAW_OCM_WORKSPACE_DEPENDENCY_DIRS: aiDir,
      }),
    ).toHaveLength(2);
  });
});

describe("runPrepackCommand", () => {
  it("keeps prepack child stdout off npm pack JSON stdout", () => {
    expect(resolvePrepackCommandStdio({ stdio: "inherit" }, { npm_config_json: "true" })).toEqual([
      "inherit",
      2,
      "inherit",
    ]);
    expect(
      resolvePrepackCommandStdio(
        { stdio: ["ignore", "pipe", "pipe"] },
        { npm_config_json: "true" },
      ),
    ).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("bounds commands that ignore termination", () => {
    const startedAt = Date.now();
    const result = runPrepackCommand(
      testNodeExecPath,
      ["--eval", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 100,
      },
    );

    expect(result.error).toBeInstanceOf(Error);
    expect(Date.now() - startedAt).toBeLessThan(2500);
  });
});
