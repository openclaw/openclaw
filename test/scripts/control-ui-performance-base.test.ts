import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { build } from "tsdown";
import { expect } from "vitest";
import { createCommandTest, type CommandFixture } from "../helpers/command-fixture.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const it = createCommandTest();
const repoRoot = process.cwd();
const tsxImport = new URL("../../scripts/tsx.mjs", import.meta.url).href;
const candidateMain =
  'import "./style.css"; import { message } from "../packages/styles/main.js"; document.body.textContent = message;';
const baseConfig = `
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { brotliCompressSync } from "node:zlib";
import { gzip } from "pako";
import { CONTROL_UI_ASSET_MANIFEST_FILENAME, CONTROL_UI_ASSET_MANIFEST_VERSION, hashControlUiAssetManifestEntries } from "../src/gateway/control-ui-asset-manifest.ts";
const outDir = path.resolve(import.meta.dirname, "../dist/control-ui");
function recordBuildIdentity(bundle) {
  const identityCapture = process.env.OPENCLAW_TEST_BUILD_IDENTITY_CAPTURE;
  if (!identityCapture) return;
  fs.appendFileSync(identityCapture, JSON.stringify({
    identity: ["GIT_COMMIT", "OPENCLAW_BUILD_TIMESTAMP", "GIT_BRANCH", "OPENCLAW_CONTROL_UI_BUILD_ID", "OPENCLAW_CONTROL_UI_RELEASE_BUILD"].map((key) => process.env[key]),
    gitDisabled: !fs.existsSync(process.env.GIT_DIR ?? "") && spawnSync("git", ["rev-parse", "HEAD"]).status !== 0,
    packageVersion: JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")).version,
    entryCode: Object.values(bundle).find((output) => output.type === "chunk" && output.isEntry).code,
  }) + "\\n");
}
export function createControlUiPrecompressedAssetVariants(fileName, source) {
  return [
    { fileName: fileName + ".gz", source: gzip(source, { level: 0, legacyHash: true }) },
    { fileName: fileName + ".br", source: brotliCompressSync(source) },
  ];
}
export default {
  build: { outDir, emptyOutDir: true },
  plugins: [{ name: "fixture-precompression", writeBundle(_options, bundle) {
    recordBuildIdentity(bundle);
    for (const output of Object.values(bundle)) {
      if (!/\\.(css|js)$/.test(output.fileName)) continue;
      for (const variant of createControlUiPrecompressedAssetVariants(output.fileName, fs.readFileSync(path.join(outDir, output.fileName)))) {
        fs.writeFileSync(path.join(outDir, variant.fileName), variant.source);
      }
    }
    const assets = fs.readdirSync(path.join(outDir, "assets"), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = path.join(entry.parentPath, entry.name);
        const source = fs.readFileSync(file);
        return { path: path.relative(outDir, file).split(path.sep).join("/"), size: source.byteLength, sha256: createHash("sha256").update(source).digest("hex") };
      })
      .sort((left, right) => left.path.localeCompare(right.path));
    fs.writeFileSync(path.join(outDir, CONTROL_UI_ASSET_MANIFEST_FILENAME), JSON.stringify({
      version: CONTROL_UI_ASSET_MANIFEST_VERSION, generation: hashControlUiAssetManifestEntries(assets), assets,
    }));
  } }],
};
`;
const candidateConfig = baseConfig.replace("level: 0", "level: 9");
const css = (count: number) =>
  Array.from({ length: count }, (_, index) => {
    const hash = createHash("sha256").update(String(index)).digest("hex");
    return `.rule-${hash.slice(0, 12)}{color:#${hash.slice(12, 18)};padding:${index % 97}px}`;
  }).join("\n");

async function createComparisonRepo(
  command: CommandFixture,
  { baseOnlyDependency = false, brokenSource = false } = {},
) {
  // A deadline abort prints the stage and the in-flight command with its elapsed time.
  const diagnostics = command.enableDiagnostics("control-ui-performance-base");
  diagnostics.stage("fixture");
  const temporaryRoot = fs.realpathSync(command.createTempDir("ui-budget-proof-"));
  const root = path.join(temporaryRoot, "repo");
  const scratch = path.join(temporaryRoot, "scratch");
  const identityCapture = path.join(temporaryRoot, "build-identities.jsonl");
  const env = createNestedGitEnv();
  const gitIdentity = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];
  const write = (file: string, text: string) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  const git = async (...args: string[]) => {
    const result = await command.run("git", [...gitIdentity, ...args], {
      cwd: root,
      env,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const commit = async (message: string) => {
    diagnostics.stage(`commit ${message}`);
    await git("add", ".");
    await git("commit", "--quiet", "-m", message);
    return git("rev-parse", "HEAD");
  };
  fs.mkdirSync(scratch, { recursive: true });
  for (const directory of [
    "scripts/lib",
    "ui",
    "packages/styles/node_modules/sizing-library",
    "extensions",
  ]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  for (const script of [
    "check-control-ui-performance-base.mts",
    "check-control-ui-performance.mts",
    "check-control-ui-precompressed-assets.mts",
    "lib/check-limits.mts",
    "lib/control-ui-i18n-config.json",
    "lib/control-ui-i18n-config.ts",
    "lib/repo-root.mjs",
    "lib/output-root-guard.mjs",
    "lib/record-shared.mjs",
    "lib/regexp.mjs",
  ]) {
    fs.copyFileSync(path.join(repoRoot, "scripts", script), path.join(root, "scripts", script));
  }
  write(
    "src/gateway/control-ui-route-preloads.ts",
    fs.readFileSync(path.join(repoRoot, "src/gateway/control-ui-route-preloads.ts"), "utf8"),
  );
  write(
    "src/gateway/control-ui-asset-manifest.ts",
    fs.readFileSync(path.join(repoRoot, "src/gateway/control-ui-asset-manifest.ts"), "utf8"),
  );
  write("scripts/tsx.mjs", `await import(${JSON.stringify(tsxImport)});\n`);
  write(".gitignore", "node_modules\ndist/\n");
  write(
    "package.json",
    JSON.stringify({
      name: "ui-budget-proof",
      version: "1.0.0",
      type: "module",
      ...(baseOnlyDependency
        ? { dependencies: { "base-only-library": "file:vendor/base-only-library" } }
        : {}),
    }),
  );
  write(
    "vendor/base-only-library/package.json",
    '{"name":"base-only-library","version":"1.0.0","type":"module","exports":"./index.js"}',
  );
  write("vendor/base-only-library/index.js", 'export const value = "base dependency";');
  write("pnpm-workspace.yaml", 'packages: ["ui", "packages/*"]\n');
  write("ui/package.json", '{"name":"ui-budget-proof-ui","type":"module"}');
  write("ui/index.html", '<script type="module" src="/main.js"></script>');
  write(
    "ui/main.js",
    brokenSource
      ? "export const = broken;"
      : baseOnlyDependency
        ? 'import "./style.css"; import { message } from "../packages/styles/main.js"; import { value } from "base-only-library"; document.body.textContent = message + "/" + value;'
        : candidateMain,
  );
  write(
    "packages/styles/main.js",
    'import "sizing-library/style.css"; export { message } from "fixture-workspace-value";',
  );
  write(
    "packages/workspace-value/package.json",
    '{"name":"fixture-workspace-value","type":"module","exports":"./index.js"}',
  );
  write("packages/workspace-value/index.js", 'export const message = "base workspace";');
  fs.symlinkSync(
    path.join(root, "packages/workspace-value"),
    path.join(root, "packages/styles/node_modules/fixture-workspace-value"),
    "junction",
  );
  write(
    "packages/styles/node_modules/sizing-library/package.json",
    '{"name":"sizing-library","exports":{"./style.css":"./style.css"}}',
  );
  write("packages/styles/node_modules/sizing-library/style.css", ".package-style{display:flex}");
  write(
    "config/control-ui-startup-budget-baseline.json",
    JSON.stringify({
      startupJsGzipBytes: 10_000,
      reason: "synthetic fixture",
      updatedAt: "2026-09-02",
    }),
  );
  write("ui/vite.config.ts", baseConfig);
  write("ui/style.css", css(1_000));
  if (baseOnlyDependency) {
    diagnostics.stage("lockfile");
    const lockfile = await command.run(
      "pnpm",
      ["install", "--lockfile-only", "--no-frozen-lockfile", "--ignore-scripts", "--offline"],
      { cwd: root, env },
    );
    expect(lockfile.error, `${lockfile.stdout}${lockfile.stderr}`).toBeUndefined();
    expect(lockfile.status, `${lockfile.stdout}${lockfile.stderr}`).toBe(0);
  }
  diagnostics.stage("init");
  await git("init", "--quiet");
  const base = await commit(brokenSource ? "broken base" : "base");
  for (const directory of ["node_modules", "ui/node_modules"]) {
    fs.rmSync(path.join(root, directory), { recursive: true, force: true });
  }
  const uiDependencies = path.join(root, "ui/node_modules");
  fs.mkdirSync(uiDependencies);
  for (const name of ["vite", "pako"]) {
    fs.symlinkSync(
      fs.realpathSync(path.join(repoRoot, "ui/node_modules", name)),
      path.join(uiDependencies, name),
      "junction",
    );
  }
  write("package.json", '{"name":"ui-budget-proof","version":"1.0.1","type":"module"}');
  write("ui/main.js", candidateMain);
  write("ui/vite.config.ts", candidateConfig);
  write("packages/workspace-value/index.js", 'export const message = "candidate workspace";');

  diagnostics.stage("compile");
  const { bundles } = await build({
    config: false,
    cwd: root,
    root,
    entry: [
      "scripts/check-control-ui-performance-base.mts",
      "scripts/check-control-ui-performance.mts",
      "scripts/check-control-ui-precompressed-assets.mts",
      "ui/vite.config.ts",
    ],
    outDir: root,
    unbundle: true,
    format: "esm",
    platform: "node",
    dts: false,
    clean: false,
    treeshake: false,
    deps: { neverBundle: ["pako"] },
    outExtensions: () => ({ js: ".js" }),
    outputOptions: { entryFileNames: "[name].js", chunkFileNames: "[name].js" },
    logLevel: "silent",
  });
  for (const bundle of bundles) {
    await bundle[Symbol.asyncDispose]();
  }
  // Keep the real CLI's source-relative subprocess paths and direct-run guards.
  for (const name of [
    "check-control-ui-performance-base",
    "check-control-ui-performance",
    "check-control-ui-precompressed-assets",
  ]) {
    fs.copyFileSync(
      path.join(root, "scripts", `${name}.js`),
      path.join(root, "scripts", `${name}.mts`),
    );
  }

  const runComparison = async (baseRef: string) => {
    diagnostics.stage("compare");
    fs.rmSync(identityCapture, { force: true });
    const result = await command.run(
      process.execPath,
      [
        "--import",
        tsxImport,
        path.join(root, "scripts/check-control-ui-performance-base.mts"),
        baseRef,
      ],
      {
        cwd: root,
        env: {
          ...env,
          GITHUB_ACTIONS: "",
          GITHUB_STEP_SUMMARY: "",
          OPENCLAW_TEST_BUILD_IDENTITY_CAPTURE: identityCapture,
          TMPDIR: scratch,
          TMP: scratch,
          TEMP: scratch,
        },
      },
    );
    expect(result.error, `${result.stdout}${result.stderr}`).toBeUndefined();
    expect(
      fs.readdirSync(scratch).filter((name) => name.startsWith("openclaw-ui-performance-base-")),
    ).toEqual([]);
    return result;
  };
  const readIdentities = () =>
    fs
      .readFileSync(identityCapture, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as Array<{
      gitDisabled: boolean;
      identity: unknown;
      packageVersion: string;
      entryCode: string;
    }>;
  return {
    temporaryRoot,
    root,
    base,
    write,
    commit,
    runComparison,
    readIdentities,
  };
}

it("builds the archived base with the candidate toolchain and keeps candidate artifacts after a growth failure", async ({
  command,
}) => {
  await command.lifetime.run(async () => {
    const repo = await createComparisonRepo(command, { baseOnlyDependency: true });
    // control-ui-performance.test.ts owns the within-budget and growth-threshold decisions;
    // one growth failure proves this CLI forwards that verdict and keeps the candidate build.
    repo.write("ui/style.css", css(1_400));
    const head = await repo.commit("candidate");
    expect(head).not.toBe(repo.base);
    const dependencyLinks = () =>
      ["vite", "pako"].map((name) =>
        fs.readlinkSync(path.join(repo.root, "ui/node_modules", name)),
      );
    const links = dependencyLinks();
    const result = await repo.runComparison(repo.base);
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(1);
    expect(output).toContain(`head ${head}; base ${repo.base}; Node ${process.version}; Vite `);
    expect(output).toContain("Pako ");
    expect(output).toMatch(/startup CSS gzip vs base: \d+ B -> \d+ B \(\+\d+ B/u);
    expect(output).toContain("startup CSS gzip growth:");
    const identities = repo.readIdentities();
    expect(identities).toHaveLength(2);
    expect(identities.map(({ packageVersion }) => packageVersion)).toEqual(["1.0.1", "1.0.0"]);
    expect(identities[0]?.identity).toEqual(identities[1]?.identity);
    expect(identities.every(({ gitDisabled }) => gitDisabled)).toBe(true);
    expect(
      identities.map(({ entryCode }) => {
        const document = {
          createElement: () => ({ relList: { supports: () => true } }),
          body: { textContent: "" },
        };
        runInNewContext(entryCode, { document });
        return document.body.textContent;
      }),
    ).toEqual(["candidate workspace", "base workspace/base dependency"]);
    // The base lockfile installs into the private archive, never the candidate checkout.
    expect(dependencyLinks()).toEqual(links);
    for (const directory of ["node_modules", "ui/node_modules"]) {
      expect(fs.existsSync(path.join(repo.root, directory, "base-only-library"))).toBe(false);
    }
    expect(fs.existsSync(path.join(repo.root, "dist/control-ui/index.html"))).toBe(true);
  });
}, 60_000);

it("falls back to absolute budgets only when the base source fails to build, not when its build is signaled", async ({
  command,
}) => {
  await command.lifetime.run(async () => {
    const repo = await createComparisonRepo(command, { brokenSource: true });
    const signalMarker = path.join(repo.temporaryRoot, "signaled-base-config");
    repo.write(
      "ui/vite.config.ts",
      `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(signalMarker)}, "loaded");
export default { plugins: [{ name: "signal", buildStart() { process.kill(process.pid, "SIGTERM"); } }] };
`,
    );
    const signaledBase = await repo.commit("signaled base");
    repo.write("ui/vite.config.ts", candidateConfig);
    const brokenBaseResult = await repo.runComparison(repo.base);
    const brokenBaseOutput = `${brokenBaseResult.stdout}${brokenBaseResult.stderr}`;
    expect(brokenBaseResult.status, brokenBaseOutput).toBe(0);
    expect(brokenBaseOutput).toContain(
      "Base Control UI source does not build with the candidate toolchain; enforcing candidate absolute budgets without a differential comparison.",
    );
    expect(brokenBaseOutput).not.toContain("startup CSS gzip vs base:");
    expect(repo.readIdentities()).toHaveLength(1);
    const signaledBaseResult = await repo.runComparison(signaledBase);
    const signaledBaseOutput = `${signaledBaseResult.stdout}${signaledBaseResult.stderr}`;
    expect(fs.readFileSync(signalMarker, "utf8")).toBe("loaded");
    expect(signaledBaseResult.status, signaledBaseOutput).toBe(1);
    expect(signaledBaseOutput).toContain(`${path.basename(process.execPath)} failed (SIGTERM)`);
    expect(signaledBaseOutput).not.toContain(
      "Base Control UI source does not build with the candidate toolchain",
    );
  });
}, 60_000);

it("refuses symlinked output roots without mutating their targets", async ({ command }) => {
  await command.lifetime.run(async () => {
    const repo = await createComparisonRepo(command);
    const protectedRoot = path.join(repo.temporaryRoot, "protected");
    fs.mkdirSync(protectedRoot);
    fs.writeFileSync(path.join(protectedRoot, "sentinel"), "keep");
    for (const outputRoot of ["dist", "dist/control-ui"]) {
      const target = path.join(repo.root, outputRoot);
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(protectedRoot, target, "junction");
      const result = await repo.runComparison(repo.base);
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
      expect(result.stderr).toContain("is a symbolic link; refusing to mutate it");
      expect(fs.readFileSync(path.join(protectedRoot, "sentinel"), "utf8")).toBe("keep");
      fs.unlinkSync(target);
    }
  });
}, 60_000);
