import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as tar from "tar";
import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { pnpmLockfileDocuments } from "../../scripts/lib/pnpm-lockfile-documents.mjs";
import * as artifacts from "../../scripts/lib/vitest-worker-artifacts.mts";
import { createPnpmRunnerSpawnSpec } from "../../scripts/pnpm-runner.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { resolveTestCorepackHome } from "../test-home-context.mts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const installArgs = ["install", "--offline", "--ignore-scripts", "--no-frozen-lockfile"];

it("keeps installed compiler inputs unchanged when another checkout imports the same package", async () => {
  const root = tempDirs.make("pnpm-install-isolation-");
  const home = path.join(root, "home");
  const packageRoot = path.join(root, "package");
  const write = (dir: string, name: string, value: string) =>
    fs.writeFileSync(path.join(dir, name), value);
  const writeJson = (dir: string, value: object) =>
    write(dir, "package.json", JSON.stringify(value));
  const repoFile = (name: string) =>
    fs.readFileSync(new URL(`../../${name}`, import.meta.url), "utf8");
  [home, packageRoot].forEach((dir) => fs.mkdirSync(dir));
  const source = "export const value = 1;\n";
  write(packageRoot, "index.js", source);
  writeJson(packageRoot, { name: "isolation-fixture", version: "1.0.0", type: "module" });
  const archive = path.join(root, "fixture.tgz");
  await tar.c({ file: archive, gzip: true, cwd: root }, ["package"]);
  const { packageManager } = JSON.parse(repoFile("package.json"));
  const { nodeLinker, packageImportMethod } = parse(repoFile("pnpm-workspace.yaml"));
  const { environment } = pnpmLockfileDocuments(repoFile("pnpm-lock.yaml"));
  expect(environment).not.toBeNull();
  const dependencies = { "isolation-fixture": `file:${archive.replaceAll("\\", "/")}` };
  const workspace = stringify({ packages: ["."], nodeLinker, packageImportMethod });
  // pnpm 12 resolves its own integrity pin even when the selected binary matches.
  const lockfile = `---\n${environment}\n---\nlockfileVersion: '9.0'\nimporters: {}\n`;
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => /^(path|pathext|systemroot)$/iu.test(key)),
    ),
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "config"),
    LOCALAPPDATA: path.join(home, "data"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    COREPACK_HOME: resolveTestCorepackHome(process.env),
    COREPACK_ENABLE_NETWORK: "0",
    CI: "true",
  };
  const install = (name: string) => {
    const cwd = path.join(root, name);
    fs.mkdirSync(cwd);
    writeJson(cwd, { name, private: true, packageManager, dependencies });
    write(cwd, "pnpm-workspace.yaml", workspace);
    write(cwd, "pnpm-lock.yaml", lockfile);
    const spec = createPnpmRunnerSpawnSpec({
      cwd,
      env,
      npmExecPath: process.env.npm_execpath,
      pnpmArgs: [...installArgs, "--store-dir", path.join(root, "store")],
      stdio: "pipe",
    });
    const result = spawnSync(spec.command, spec.args, {
      ...spec.options,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return path.join(cwd, "node_modules/isolation-fixture/index.js");
  };
  const first = install("first");
  const before = fs.statSync(first);
  const inputs = { [first]: artifacts.hashVitestWorkerArtifact(source) };
  const manifest = { identity: "install-isolation-fixture", inputs, outputs: {}, durationMs: 0 };
  const second = install("second");
  expect(fs.readFileSync(second, "utf8")).toBe(source);
  expect(fs.statSync(first).ctimeMs).toBe(before.ctimeMs);
  await artifacts.verifyVitestWorkerArtifacts(root, manifest);
  fs.writeFileSync(second, "export const value = 2;\n");
  expect(fs.readFileSync(first, "utf8")).toBe(source);
});
