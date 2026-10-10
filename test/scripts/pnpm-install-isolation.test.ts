import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as tar from "tar";
import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { pnpmLockfileDocuments } from "../../scripts/lib/pnpm-lockfile-documents.mjs";
import {
  hashVitestWorkerArtifact,
  verifyVitestWorkerArtifacts,
} from "../../scripts/lib/vitest-worker-artifacts.mts";
import { createPnpmRunnerSpawnSpec } from "../../scripts/pnpm-runner.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { resolveTestCorepackHome } from "../test-home-context.mts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps installed compiler inputs unchanged when another checkout imports the same package", async () => {
  const root = tempDirs.make("pnpm-install-isolation-");
  const home = path.join(root, "home");
  const packageRoot = path.join(root, "package");
  fs.mkdirSync(home);
  fs.mkdirSync(packageRoot);
  const source = "export const value = 1;\n";
  fs.writeFileSync(path.join(packageRoot, "index.js"), source);
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "isolation-fixture", version: "1.0.0", type: "module" }),
  );
  const archive = path.join(root, "fixture.tgz");
  await tar.c({ file: archive, gzip: true, cwd: root }, ["package"]);
  const { packageManager } = JSON.parse(
    fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const { nodeLinker, packageImportMethod } = parse(
    fs.readFileSync(new URL("../../pnpm-workspace.yaml", import.meta.url), "utf8"),
  );
  const { environment } = pnpmLockfileDocuments(
    fs.readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8"),
  );
  expect(environment).not.toBeNull();
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
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name,
        private: true,
        packageManager,
        dependencies: { "isolation-fixture": `file:${archive.replaceAll("\\", "/")}` },
      }),
    );
    fs.writeFileSync(
      path.join(cwd, "pnpm-workspace.yaml"),
      stringify({ packages: ["."], nodeLinker, packageImportMethod }),
    );
    // pnpm 12 resolves its own integrity pin even when the selected binary matches.
    fs.writeFileSync(
      path.join(cwd, "pnpm-lock.yaml"),
      `---\n${environment}\n---\nlockfileVersion: '9.0'\nimporters: {}\n`,
    );
    const spec = createPnpmRunnerSpawnSpec({
      cwd,
      env,
      npmExecPath: process.env.npm_execpath,
      pnpmArgs: [
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-frozen-lockfile",
        "--store-dir",
        path.join(root, "store"),
      ],
      stdio: "pipe",
    });
    const result = spawnSync(spec.command, spec.args, {
      ...spec.options,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return path.join(cwd, "node_modules/isolation-fixture/index.js");
  };
  const first = install("first");
  const before = fs.statSync(first);
  const manifest = {
    identity: "install-isolation-fixture",
    inputs: { [first]: hashVitestWorkerArtifact(source) },
    outputs: {},
    durationMs: 0,
  };
  const second = install("second");

  expect(fs.readFileSync(second, "utf8")).toBe(source);
  expect(fs.statSync(first).ctimeMs).toBe(before.ctimeMs);
  await verifyVitestWorkerArtifacts(root, manifest, { inputsChangedAfter: before.ctimeMs + 1 });
  fs.writeFileSync(second, "export const value = 2;\n");
  expect(fs.readFileSync(first, "utf8")).toBe(source);
});
