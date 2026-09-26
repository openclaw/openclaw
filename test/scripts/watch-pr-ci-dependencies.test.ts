import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { watchPrCiDependencyOptions } from "../../scripts/lib/watch-pr-ci-dependencies.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function writePackage(root: string, name: string, value: string, version = "1.0.0") {
  const directory = join(root, "node_modules", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name, version, type: "module", exports: "./index.mjs" }),
  );
  writeFileSync(join(directory, "index.mjs"), `export default ${JSON.stringify(value)};\n`);
}

it.each([
  "env",
  "config",
  "canonical",
  "installed",
  "configured",
  "missing",
  "different",
  "subdirectory",
  "sparse",
])("selects the %s dependency context without changing the checkout", (source) => {
  const root = tempDirs.make("openclaw-watch-root-");
  const canonical = join(root, "canonical");
  const checkout = join(root, "checkout");
  const tooling = join(root, "tooling #root");
  mkdirSync(join(canonical, "node_modules"), { recursive: true });
  mkdirSync(join(tooling, "node_modules"), { recursive: true });
  mkdirSync(checkout);
  symlinkSync(
    canonical,
    join(canonical, "alias"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const git = vi.mocked(spawnSync).mockImplementation((_command, args) => {
    const cwd = args?.[1];
    const command = args?.slice(2).join(" ");
    let stdout: string;
    let status = 0;
    if (command === "rev-parse --path-format=absolute --git-common-dir") {
      expect(cwd).toBe(checkout);
      stdout = join(canonical, ".git");
    } else if (command === "config --path --get openclaw.pr.toolingRoot") {
      expect(cwd).toBe(canonical);
      stdout = source === "canonical" ? "" : "../tooling #root\n";
      status = source === "canonical" ? 1 : 0;
    } else {
      // Like scripts/pr, the canonical default needs no identity queries.
      expect(source).not.toBe("canonical");
      if (command === "rev-parse --is-inside-work-tree") {
        stdout = "true\n";
      } else if (command === "rev-parse --show-toplevel") {
        stdout = source === "subdirectory" ? root : `${cwd}\n`;
      } else if (command === "config --bool --get core.sparseCheckout") {
        stdout = source === "sparse" ? "true\n" : "";
        status = source === "sparse" ? 0 : 1;
      } else if (command === "remote get-url origin") {
        stdout =
          cwd === checkout
            ? "https://github.com/OpenClaw/OpenClaw.git\n"
            : source === "different"
              ? "https://github.com/example/other.git\n"
              : "git@github.com:openclaw/openclaw.git\n";
      } else {
        throw new Error(`Unexpected Git command: ${command}`);
      }
    }
    return {
      status,
      stdout,
      stderr: "",
      pid: 0,
      output: [],
      signal: null,
    };
  });
  const notice = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv(
    "OPENCLAW_PR_TOOLING_ROOT",
    source === "env" ? "alias" : source === "missing" || source === "installed" ? root : "",
  );
  try {
    if (source === "installed" || source === "configured") {
      if (source === "installed") {
        mkdirSync(join(checkout, "node_modules"));
      } else {
        vi.stubEnv("PNPM_CONFIG_MODULES_DIR", join(tooling, "node_modules"));
      }
      expect(watchPrCiDependencyOptions(checkout)).toEqual({});
      expect(notice).not.toHaveBeenCalled();
    } else if (["missing", "different", "subdirectory", "sparse"].includes(source)) {
      const reasons: Record<string, string> = {
        missing: "Missing node_modules",
        different: "Different repository",
        subdirectory: "Not a repository top level",
        sparse: "Sparse checkout",
      };
      expect(() => watchPrCiDependencyOptions(checkout)).toThrow(reasons[source]);
      expect(notice).not.toHaveBeenCalled();
    } else {
      watchPrCiDependencyOptions(checkout);
      expect(notice.mock.calls).toEqual([
        [
          `[watch-pr-ci] resolving missing packages from scripts/pr tooling root ${source === "config" ? tooling : canonical}`,
        ],
      ]);
    }
    expect(existsSync(join(checkout, "node_modules"))).toBe(source === "installed");
  } finally {
    git.mockRestore();
  }
});

it("checks fallback versions before loading through the watcher child and preserves local resolution", () => {
  const root = tempDirs.make("openclaw-watch-dependencies-");
  const checkout = join(root, "checkout");
  const tooling = join(root, "tooling #root");
  const lib = join(checkout, "scripts", "lib");
  mkdirSync(lib, { recursive: true });
  for (const directory of [checkout, tooling]) {
    const initialized = spawnSync("git", ["init", "--quiet", directory], { encoding: "utf8" });
    expect(initialized.status, initialized.stderr).toBe(0);
    const origin = spawnSync(
      "git",
      ["-C", directory, "remote", "add", "origin", "https://github.com/openclaw/openclaw.git"],
      { encoding: "utf8" },
    );
    expect(origin.status, origin.stderr).toBe(0);
  }
  writeFileSync(
    join(checkout, "package.json"),
    JSON.stringify({
      dependencies: { "fixture-pkg": "1.0.0" },
      devDependencies: { "dev-pkg": "1.0.0" },
      optionalDependencies: { "@fixture/scoped": "1.0.0" },
    }),
  );
  for (const file of [
    "tsx-cli-shim.mjs",
    "local-check-runtime.mts",
    "watch-pr-ci-dependencies.mjs",
  ]) {
    copyFileSync(resolve("scripts/lib", file), join(lib, file));
  }
  copyFileSync(resolve("scripts/watch-pr-ci.mjs"), join(checkout, "scripts/watch-pr-ci.mjs"));
  writePackage(tooling, "fixture-pkg", "tooling");
  writePackage(tooling, "dev-pkg", "dev");
  writePackage(tooling, "@fixture/scoped", "scoped");
  writeFileSync(
    join(tooling, "node_modules/@fixture/scoped/package.json"),
    JSON.stringify({ version: "1.0.0", type: "module", exports: { "./subpath": "./index.mjs" } }),
  );
  writePackage(tooling, "local-pkg", "fallback");
  writeFileSync(
    join(tooling, "node_modules/local-pkg/package.json"),
    JSON.stringify({ type: "module", exports: { ".": "./index.mjs", "./private": "./index.mjs" } }),
  );
  writePackage(join(checkout, "scripts"), "local-pkg", "local");
  writeFileSync(join(tooling, "relative.mjs"), 'export default "wrong";\n');
  writeFileSync(
    join(checkout, "scripts/watch-pr-ci.mts"),
    `import assert from "node:assert/strict";
import missing from "fixture-pkg";
import dev from "dev-pkg";
import scoped from "@fixture/scoped/subpath";
import local from "local-pkg";
assert.equal(missing, "tooling");
assert.equal(dev, "dev");
assert.equal(scoped, "scoped");
assert.equal(local, "local");
for (const specifier of ["./relative.mjs", new URL("./relative.mjs", import.meta.url).href]) {
  await assert.rejects(import(specifier), { code: "ERR_MODULE_NOT_FOUND" });
}
await assert.rejects(import("local-pkg/private"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
console.log("fallback and local resolution OK");
`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: "",
    OPENCLAW_PR_TOOLING_ROOT: tooling,
    OPENCLAW_PR_LOCK_NOTIFY_FD: "",
  };
  // A configured modules directory selects the shim's link path instead of the fallback.
  for (const name of [
    "PNPM_CONFIG_MODULES_DIR",
    "pnpm_config_modules_dir",
    "npm_config_modules_dir",
  ]) {
    delete env[name];
  }
  const run = () =>
    spawnSync(process.execPath, [join(checkout, "scripts/watch-pr-ci.mjs")], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      env,
    });
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("fallback and local resolution OK\n");
  expect(result.stderr).toBe(
    `[watch-pr-ci] resolving missing packages from scripts/pr tooling root ${tooling}\n`,
  );
  writePackage(tooling, "fixture-pkg", "stale", "0.0.0-stale");
  writeFileSync(
    join(tooling, "node_modules/fixture-pkg/index.mjs"),
    'console.log("STALE FIXTURE LOADED"); export default "tooling";\n',
  );
  for (const required of ["1.0.0", "undeclared"]) {
    if (required === "undeclared") {
      writeFileSync(join(checkout, "package.json"), "{}");
    }
    const rejected = run();
    expect(rejected.status, rejected.stderr).toBe(1);
    expect(rejected.stderr).toContain("'fixture-pkg' has version 0.0.0-stale");
    expect(rejected.stderr).toContain(`requires ${required}`);
    expect(rejected.stderr).toContain(tooling);
    expect(rejected.stderr).toContain("pnpm install --frozen-lockfile");
    expect(rejected.stdout + rejected.stderr).not.toContain("STALE FIXTURE LOADED");
  }
  expect(existsSync(join(checkout, "node_modules"))).toBe(false);
});
