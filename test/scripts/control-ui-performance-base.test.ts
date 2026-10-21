import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { build } from "tsdown";
import { expect } from "vitest";
import { createCommandTest, type CommandFixture } from "../helpers/command-fixture.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const test = createCommandTest();
const repoRoot = process.cwd();
const tsxImport = new URL("../../scripts/tsx.mjs", import.meta.url).href;
const cliNames = [
  "check-control-ui-performance-base",
  "check-control-ui-performance",
  "check-control-ui-precompressed-assets",
];
const candidateMain =
  'import "./style.css"; import { message } from "../packages/styles/main.js"; document.body.textContent = message;';
const baseConfig = `
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { brotliCompressSync } from "node:zlib";
import { gzip } from "pako";
const outDir = path.resolve(import.meta.dirname, "../dist/control-ui");
export function createControlUiPrecompressedAssetVariants(fileName, source) {
  return [
    { fileName: fileName + ".gz", source: gzip(source, { level: 0, legacyHash: true }) },
    { fileName: fileName + ".br", source: brotliCompressSync(source) },
  ];
}
export default {
  build: { outDir, emptyOutDir: true },
  plugins: [{ name: "fixture-precompression", writeBundle(_options, bundle) {
    fs.appendFileSync(process.env.OPENCLAW_TEST_BUILD_IDENTITY_CAPTURE, JSON.stringify({
      identity: ["GIT_COMMIT", "OPENCLAW_BUILD_TIMESTAMP", "GIT_BRANCH", "OPENCLAW_CONTROL_UI_BUILD_ID", "OPENCLAW_CONTROL_UI_RELEASE_BUILD"].map((key) => process.env[key]),
      gitDisabled: !fs.existsSync(process.env.GIT_DIR ?? "") && spawnSync("git", ["rev-parse", "HEAD"]).status !== 0,
      packageVersion: JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")).version,
      entryCode: Object.values(bundle).find((output) => output.type === "chunk" && output.isEntry).code,
    }) + "\\n");
    for (const output of Object.values(bundle)) {
      if (!/\\.(css|js)$/.test(output.fileName)) continue;
      for (const variant of createControlUiPrecompressedAssetVariants(output.fileName, fs.readFileSync(path.join(outDir, output.fileName)))) {
        fs.writeFileSync(path.join(outDir, variant.fileName), variant.source);
      }
    }
  } }],
};
`;
const candidateConfig = baseConfig
  .replace("level: 0", "level: 9")
  .replace("export function createControlUi", "export async function createControlUi")
  .replace(
    'name: "fixture-precompression", writeBundle',
    'name: "fixture-precompression", async writeBundle',
  )
  .replace("for (const variant of createControlUi", "for (const variant of await createControlUi");
const css = (count: number) =>
  Array.from({ length: count }, (_, index) => {
    const hash = createHash("sha256").update(String(index)).digest("hex");
    return `.rule-${hash.slice(0, 12)}{color:#${hash.slice(12, 18)};padding:${index % 97}px}`;
  }).join("\n");

async function createComparisonRepo(
  command: CommandFixture,
  { baseOnlyDependency = false, brokenSource = false } = {},
) {
  const diagnostics = command.enableDiagnostics("control-ui-performance-base");
  diagnostics.stage("fixture");
  const temporaryRoot = fs.realpathSync(command.createTempDir("ui-budget-proof-"));
  const root = path.join(temporaryRoot, "repo");
  const at = (...parts: string[]) => path.join(root, ...parts);
  const scratch = path.join(temporaryRoot, "scratch");
  const identityCapture = path.join(temporaryRoot, "build-identities.jsonl");
  const env = createNestedGitEnv();
  const run = (bin: string, args: string[], runEnv = env) =>
    command.run(bin, args, { cwd: root, env: runEnv });
  const gitIdentity = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];
  const write = (file: string, text: string) => {
    const target = at(file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  const git = async (...args: string[]) => {
    const result = await run("git", [...gitIdentity, ...args]);
    expect(result, result.stderr).toMatchObject({ error: undefined, status: 0 });
    return result.stdout.trim();
  };
  const commit = async (message: string) => {
    diagnostics.stage(`commit ${message}`);
    await git("add", ".");
    await git("commit", "--quiet", "-m", message);
    return git("rev-parse", "HEAD");
  };
  fs.mkdirSync(scratch, { recursive: true });
  for (const directory of ["scripts/lib", "extensions"]) {
    fs.mkdirSync(at(directory), { recursive: true });
  }
  for (const script of [
    ...cliNames.map((name) => `${name}.mts`),
    "lib/check-limits.mts",
    "lib/control-ui-i18n-config.json",
    "lib/control-ui-i18n-config.ts",
    "lib/repo-root.mjs",
    "lib/output-root-guard.mjs",
    "lib/record-shared.mjs",
    "lib/regexp.mjs",
  ]) {
    fs.copyFileSync(path.join(repoRoot, "scripts", script), at("scripts", script));
  }
  write(
    "src/gateway/control-ui-route-preloads.ts",
    fs.readFileSync(path.join(repoRoot, "src/gateway/control-ui-route-preloads.ts"), "utf8"),
  );
  const manifest = (file: string, value: object) => write(file, JSON.stringify(value));
  manifest("package.json", {
    name: "ui-budget-proof",
    version: "1.0.0",
    type: "module",
    ...(baseOnlyDependency
      ? { dependencies: { "base-only-library": "file:vendor/base-only-library" } }
      : {}),
  });
  for (const [file, source] of Object.entries({
    "scripts/tsx.mjs": `await import(${JSON.stringify(tsxImport)});\n`,
    ".gitignore": "node_modules\ndist/\n",
    "vendor/base-only-library/package.json":
      '{"name":"base-only-library","version":"1.0.0","type":"module","exports":"./index.js"}',
    "vendor/base-only-library/index.js": 'export const value = "base dependency";',
    "pnpm-workspace.yaml": 'packages: ["ui", "packages/*"]\n',
    "ui/package.json": '{"name":"ui-budget-proof-ui","type":"module"}',
    "ui/index.html": '<script type="module" src="/main.js"></script>',
    "ui/main.js": brokenSource
      ? "export const = broken;"
      : baseOnlyDependency
        ? 'import "./style.css"; import { message } from "../packages/styles/main.js"; import { value } from "base-only-library"; document.body.textContent = message + "/" + value;'
        : candidateMain,
    "packages/styles/main.js":
      'import "sizing-library/style.css"; export { message } from "fixture-workspace-value";',
    "packages/workspace-value/package.json":
      '{"name":"fixture-workspace-value","type":"module","exports":"./index.js"}',
    "packages/workspace-value/index.js": 'export const message = "base workspace";',
    "packages/styles/node_modules/sizing-library/package.json":
      '{"name":"sizing-library","exports":{"./style.css":"./style.css"}}',
    "packages/styles/node_modules/sizing-library/style.css": ".package-style{display:flex}",
    "ui/vite.config.ts": baseConfig,
    "ui/style.css": css(1_000),
  })) {
    write(file, source);
  }
  fs.symlinkSync(
    at("packages/workspace-value"),
    at("packages/styles/node_modules/fixture-workspace-value"),
    "junction",
  );
  manifest("config/control-ui-startup-budget-baseline.json", {
    startupJsGzipBytes: 10_000,
    reason: "synthetic fixture",
    updatedAt: "2026-09-02",
  });
  if (baseOnlyDependency) {
    diagnostics.stage("lockfile");
    const lockfile = await run("pnpm", [
      "install",
      "--lockfile-only",
      "--no-frozen-lockfile",
      "--ignore-scripts",
      "--offline",
    ]);
    expect(lockfile, `${lockfile.stdout}${lockfile.stderr}`).toMatchObject({
      error: undefined,
      status: 0,
    });
  }
  diagnostics.stage("init");
  await git("init", "--quiet");
  const base = await commit(brokenSource ? "broken base" : "base");
  for (const directory of ["node_modules", "ui/node_modules"]) {
    fs.rmSync(at(directory), { recursive: true, force: true });
  }
  const uiDependencies = at("ui/node_modules");
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
    entry: [...cliNames.map((name) => `scripts/${name}.mts`), "ui/vite.config.ts"],
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
  for (const name of cliNames) {
    fs.copyFileSync(at("scripts", `${name}.js`), at("scripts", `${name}.mts`));
  }

  const runComparison = async (baseRef: string, status: number) => {
    diagnostics.stage("compare");
    fs.rmSync(identityCapture, { force: true });
    const result = await run(
      process.execPath,
      ["--import", tsxImport, at("scripts/check-control-ui-performance-base.mts"), baseRef],
      {
        ...env,
        GITHUB_ACTIONS: "",
        GITHUB_STEP_SUMMARY: "",
        OPENCLAW_TEST_BUILD_IDENTITY_CAPTURE: identityCapture,
        TMPDIR: scratch,
        TMP: scratch,
        TEMP: scratch,
      },
    );
    const output = `${result.stdout}${result.stderr}`;
    expect(result, output).toMatchObject({ error: undefined, status });
    expect(
      fs.readdirSync(scratch).filter((name) => name.startsWith("openclaw-ui-performance-base-")),
    ).toEqual([]);
    return { ...result, output };
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
  return { temporaryRoot, at, base, write, commit, runComparison, readIdentities };
}

function it(
  name: string,
  options: Parameters<typeof createComparisonRepo>[1],
  verify: (repo: Awaited<ReturnType<typeof createComparisonRepo>>) => Promise<void>,
) {
  test(
    name,
    ({ command }) =>
      command.lifetime.run(async () => verify(await createComparisonRepo(command, options))),
    60_000,
  );
}

it("compares archived source revisions", { baseOnlyDependency: true }, async (repo) => {
  repo.write("ui/style.css", css(1_400));
  const head = await repo.commit("candidate");
  expect(head).not.toBe(repo.base);
  const dependencyLinks = () =>
    ["vite", "pako"].map((name) => fs.readlinkSync(repo.at("ui/node_modules", name)));
  const links = dependencyLinks();
  const { output } = await repo.runComparison(repo.base, 1);
  expect(output).toContain(`head ${head}; base ${repo.base}; Node ${process.version}; Vite `);
  expect(output).toContain("Pako ");
  expect(output).toMatch(/startup CSS gzip vs base: \d+ B -> \d+ B \(\+\d+ B/u);
  expect(output).toContain("startup CSS gzip growth:");
  const identities = repo.readIdentities();
  expect(identities).toMatchObject([
    { packageVersion: "1.0.1", gitDisabled: true },
    { packageVersion: "1.0.0", gitDisabled: true },
  ]);
  expect(identities[0]?.identity).toEqual(identities[1]?.identity);
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
    expect(fs.existsSync(repo.at(directory, "base-only-library"))).toBe(false);
  }
  expect(fs.existsSync(repo.at("dist/control-ui/index.html"))).toBe(true);
});

it("distinguishes failure from signal", { brokenSource: true }, async (repo) => {
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
  const { output: brokenBaseOutput } = await repo.runComparison(repo.base, 0);
  expect(brokenBaseOutput).toContain(
    "Base Control UI source does not build with the candidate toolchain; enforcing candidate absolute budgets without a differential comparison.",
  );
  expect(brokenBaseOutput).not.toContain("startup CSS gzip vs base:");
  expect(repo.readIdentities()).toHaveLength(1);
  const { output: signaledBaseOutput } = await repo.runComparison(signaledBase, 1);
  expect(fs.readFileSync(signalMarker, "utf8")).toBe("loaded");
  expect(signaledBaseOutput).toContain(`${path.basename(process.execPath)} failed (SIGTERM)`);
  expect(signaledBaseOutput).not.toContain(
    "Base Control UI source does not build with the candidate toolchain",
  );
});

it("refuses symlinked output roots without mutating targets", {}, async (repo) => {
  const protectedRoot = path.join(repo.temporaryRoot, "protected");
  fs.mkdirSync(protectedRoot);
  fs.writeFileSync(path.join(protectedRoot, "sentinel"), "keep");
  for (const outputRoot of ["dist", "dist/control-ui"]) {
    const target = repo.at(outputRoot);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(protectedRoot, target, "junction");
    const { stderr } = await repo.runComparison(repo.base, 1);
    expect(stderr).toContain("is a symbolic link; refusing to mutate it");
    expect(fs.readFileSync(path.join(protectedRoot, "sentinel"), "utf8")).toBe("keep");
    fs.unlinkSync(target);
  }
});
