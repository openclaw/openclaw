import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectRuntimeImportClosure } from "../../scripts/lib/runtime-import-closure.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { copyPrWrapperSources, linkPrWrapperDependencies } from "./pr-wrapper.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const itPosix = process.platform === "win32" ? it.skip : it;

it("resolves wrapper package exports and workspace aliases from the extracted dependency context", () => {
  const root = tempDirs.make("openclaw-pr-package-closure-");
  copyPrWrapperSources(root);
  const pinned = spawnSync(
    process.execPath,
    [
      join(root, "scripts/pr-lib/materialize-dependencies.mjs"),
      join(process.cwd(), "node_modules"),
      join(root, "node_modules"),
    ],
    { encoding: "utf8" },
  );
  expect(pinned.status, pinned.stderr).toBe(0);
  const files = globSync("**/*.{js,mjs,cjs,ts,mts,cts,tsx}", {
    cwd: root,
    exclude: ["node_modules/**"],
  });
  const closure = collectRuntimeImportClosure(root, files, { validatePackages: true });
  expect(closure.filter((file) => file.startsWith("..") || !existsSync(join(root, file)))).toEqual(
    [],
  );
});

it.each([
  { source: 'import type { Missing } from "./missing.mts";', loadsModule: false },
  { source: 'import { type Missing } from "./missing.mts";', loadsModule: true },
  { source: 'export type { Missing } from "./missing.mts";', loadsModule: false },
  { source: 'export { type Missing } from "./missing.mts";', loadsModule: true },
])("matches plain Node's dependency requirement for $source", ({ source, loadsModule }) => {
  const root = tempDirs.make("openclaw-eager-import-closure-");
  const entry = join(root, "entry.mts");
  writeFileSync(entry, `${source}\nconsole.log("entry executed");\n`);
  const result = spawnSync(process.execPath, [entry], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
  });
  expect(result.status, result.stderr).toBe(loadsModule ? 1 : 0);
  const input = relative(process.cwd(), entry).replaceAll("\\", "/");
  if (loadsModule) {
    expect(result.stderr).toContain("Cannot find module");
    expect(() => collectRuntimeImportClosure(process.cwd(), [input])).toThrow(
      "unresolved ./missing.mts",
    );
  } else {
    expect(result.stdout.trim()).toBe("entry executed");
    expect(collectRuntimeImportClosure(process.cwd(), [input])).toEqual([input]);
  }
});

itPosix.each(["empty", "legacy", "outdated"])(
  "boots an anchor handed off by an older wrapper (dependencies=%s)",
  (dependencies) => {
    const root = tempDirs.make("openclaw-pr-anchor-dependencies-");
    const canonical = join(root, "canonical");
    const anchor = join(root, "anchor");
    mkdirSync(canonical);
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      OPENCLAW_PR_ANCHOR_REPO_ROOT: canonical,
      TSX_TSCONFIG_PATH: join(anchor, "tsconfig.json"),
    };
    const initialized = spawnSync("git", ["init", canonical], { env, encoding: "utf8" });
    expect(initialized.status, initialized.stderr).toBe(0);
    copyPrWrapperSources(anchor);
    linkPrWrapperDependencies(canonical);
    if (dependencies === "legacy") {
      mkdirSync(join(anchor, "node_modules"));
      // The pre-#149585 parent only knew these four packages. Its code cannot be updated.
      for (const dependency of ["tsx", "zod", "minimatch", "yaml"]) {
        symlinkSync(
          realpathSync(join(canonical, "node_modules", dependency)),
          join(anchor, "node_modules", dependency),
          process.platform === "win32" ? "junction" : "dir",
        );
      }
    }
    if (dependencies === "outdated") {
      const obsoletePackage = join(root, "obsolete-fs-safe");
      mkdirSync(obsoletePackage);
      writeFileSync(join(obsoletePackage, "package.json"), JSON.stringify({ version: "0.5.6" }));
      const donor = join(canonical, "node_modules/@openclaw/fs-safe");
      rmSync(donor);
      symlinkSync(obsoletePackage, donor, process.platform === "win32" ? "junction" : "dir");
    }
    const bootstrap = spawnSync(join(anchor, "scripts/pr"), ["review-init"], {
      env,
      encoding: "utf8",
    });
    if (dependencies === "outdated") {
      expect(bootstrap.status, bootstrap.stderr).toBe(1);
      expect(bootstrap.stderr).toContain("has version 0.5.6; the trust anchor requires");
      expect(bootstrap.stderr).toContain(
        "Restore frozen dependencies in a clean trusted-main checkout",
      );
      expect(existsSync(join(anchor, "node_modules"))).toBe(false);
      const locks = spawnSync("git", ["-C", canonical, "for-each-ref", "refs/openclaw"], {
        env,
        encoding: "utf8",
      });
      expect(locks.status, locks.stderr).toBe(0);
      expect(locks.stdout).toBe("");
      return;
    }
    expect(bootstrap.status, bootstrap.stderr).toBe(2);
    expect(bootstrap.stdout).toContain("scripts/pr review-init <PR>");
    const provision = spawnSync(
      process.execPath,
      [
        "--import",
        join(anchor, "scripts/tsx.mjs"),
        join(anchor, "scripts/pr-lib/worktree-provision.mts"),
      ],
      { env, encoding: "utf8" },
    );
    expect(provision.status, provision.stderr).toBe(1);
    expect(provision.stderr).toContain("Usage: worktree-provision.mts");

    if (dependencies !== "legacy") {
      return;
    }
    rmSync(join(canonical, "node_modules/yaml"));
    const supervised = spawnSync(join(anchor, "scripts/pr"), ["review-init"], {
      env,
      encoding: "utf8",
    });
    expect(supervised.status, supervised.stderr).toBe(2);
    expect(supervised.stdout).toContain("scripts/pr review-init <PR>");
  },
);

itPosix.each([false, true])("launches a pre-helper anchor (manifest=%s)", (manifest) => {
  const root = tempDirs.make("openclaw-pr-legacy-anchor-");
  const canonical = join(root, "canonical");
  const linked = join(root, "linked");
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    TMPDIR: root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "OpenClaw Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "OpenClaw Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
      { cwd, env, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git(root, "init", "-b", "main", canonical);
  mkdirSync(join(canonical, "scripts/pr-lib"), { recursive: true });
  const wrapper = join(canonical, "scripts/pr");
  // The old entrypoint understands the verified handoff but has no dependency helper.
  writeFileSync(
    wrapper,
    '#!/bin/bash\n# OPENCLAW_PR_ANCHOR_REPO_ROOT\nexec node "$(dirname "$0")/pr-lib/legacy-entry.mjs"\n',
  );
  chmodSync(wrapper, 0o755);
  writeFileSync(
    join(canonical, "scripts/pr-lib/legacy-entry.mjs"),
    `import "${manifest ? "@openclaw/fs-safe/config" : "yaml"}";\nconsole.log("legacy anchor loaded");\n`,
  );
  writeFileSync(
    join(canonical, "scripts/pr-lib/wrapper-components.txt"),
    `${manifest ? "package.json\n" : ""}scripts/pr-lib/legacy-entry.mjs\n`,
  );
  if (manifest) {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    packageJson.dependencies["@openclaw/fs-safe"] = "0.0.0-fixture";
    writeFileSync(join(canonical, "package.json"), JSON.stringify(packageJson));
  }
  git(canonical, "add", ".");
  git(canonical, "commit", "-m", "test: pre-helper anchor");
  git(canonical, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(canonical, "worktree", "add", "-b", "caller", linked);
  copyFileSync("scripts/pr", join(linked, "scripts/pr"));
  copyFileSync(
    "scripts/pr-lib/materialize-dependencies.mjs",
    join(linked, "scripts/pr-lib/materialize-dependencies.mjs"),
  );
  git(linked, "add", "scripts");
  git(linked, "commit", "-m", "test: newer caller");
  git(canonical, "checkout", "-b", "parked");
  writeFileSync(wrapper, `${readFileSync(wrapper, "utf8")}# parked\n`);
  git(canonical, "commit", "-am", "test: park canonical wrapper");
  linkPrWrapperDependencies(canonical);
  if (manifest) {
    // The anchor's required version can differ from the newer parent's manifest.
    const dependency = join(root, "older-fs-safe");
    mkdirSync(dependency);
    writeFileSync(
      join(dependency, "package.json"),
      JSON.stringify({
        name: "@openclaw/fs-safe",
        version: "0.0.0-fixture",
        type: "module",
        exports: { "./config": "./config.js" },
      }),
    );
    writeFileSync(join(dependency, "config.js"), "export {};\n");
    const installed = join(canonical, "node_modules/@openclaw/fs-safe");
    rmSync(installed);
    symlinkSync(dependency, installed, "dir");
  }

  const result = spawnSync(join(linked, "scripts/pr"), ["review-init"], {
    cwd: linked,
    env,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain("running wrapper code materialized from");
  expect(result.stdout).toBe("legacy anchor loaded\n");
  expect(git(canonical, "for-each-ref", "refs/openclaw")).toBe("");
});

it("captures lazy platform modules and their runtime dependencies without loading them", () => {
  const directory = tempDirs.make("openclaw-runtime-import-closure-");
  writeFileSync(
    join(directory, "entry.mts"),
    'export const load = () => import("./platform.mts");',
  );
  writeFileSync(
    join(directory, "platform.mts"),
    'import "./native.js"; throw new Error("must not load");',
  );
  writeFileSync(join(directory, "native.ts"), 'import type { Missing } from "./erased.ts";');
  const entry = relative(process.cwd(), join(directory, "entry.mts")).replaceAll("\\", "/");
  expect(collectRuntimeImportClosure(process.cwd(), [entry])).toEqual([entry]);
  expect(
    collectRuntimeImportClosure(process.cwd(), [entry], { includeDynamicImports: true }),
  ).toEqual(
    ["entry.mts", "platform.mts", "native.ts"]
      .map((file) => relative(process.cwd(), join(directory, file)).replaceAll("\\", "/"))
      .toSorted(),
  );
});
