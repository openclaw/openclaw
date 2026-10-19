import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { toolingDependencyOptions } from "../../scripts/lib/tooling-dependencies.mjs";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.mocked(spawnSync).mockRestore();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function writeJson(file: string, value: unknown) {
  writeFileSync(file, JSON.stringify(value));
}

function writePackage(
  root: string,
  name: string,
  value: string,
  version = "1.0.0",
  exports: string | Record<string, string> = "./index.mjs",
) {
  const directory = join(root, "node_modules", name);
  mkdirSync(directory, { recursive: true });
  writeJson(join(directory, "package.json"), { name, version, type: "module", exports });
  writeFileSync(join(directory, "index.mjs"), `export default ${JSON.stringify(value)};\n`);
}

it.each<{ source: string; reason?: string }>([
  { source: "env" },
  { source: "config" },
  { source: "canonical" },
  { source: "installed" },
  { source: "configured" },
  { source: "missing", reason: "Missing node_modules" },
  { source: "different", reason: "Different repository" },
  { source: "subdirectory", reason: "Not a repository top level" },
  { source: "sparse", reason: "Sparse checkout" },
])("selects the $source dependency context without changing the checkout", ({ source, reason }) => {
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
  vi.mocked(spawnSync).mockImplementation((_command, args) => {
    const cwd = args?.[1];
    const command = args?.slice(2).join(" ") ?? "";
    const responses: Record<string, string> = {
      "rev-parse --path-format=absolute --git-common-dir": join(canonical, ".git"),
      "config --path --get openclaw.pr.toolingRoot":
        source === "canonical" ? "" : "../tooling #root\n",
      "rev-parse --is-inside-work-tree": "true\n",
      "rev-parse --show-toplevel": source === "subdirectory" ? root : `${cwd}\n`,
      "config --bool --get core.sparseCheckout": source === "sparse" ? "true\n" : "",
      "remote get-url origin":
        cwd === checkout
          ? "https://github.com/OpenClaw/OpenClaw.git\n"
          : `git@github.com:${source === "different" ? "example/other" : "openclaw/openclaw"}.git\n`,
    };
    if (!Object.hasOwn(responses, command)) {
      throw new Error(`Unexpected Git command: ${command}`);
    }
    if (command.endsWith("--git-common-dir")) {
      expect(cwd).toBe(checkout);
    } else if (command.endsWith("openclaw.pr.toolingRoot")) {
      expect(cwd).toBe(canonical);
    } else {
      expect(source).not.toBe("canonical");
    }
    const stdout = responses[command]!;
    return { status: stdout ? 0 : 1, stdout, stderr: "", pid: 0, output: [], signal: null };
  });
  const notice = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv(
    "OPENCLAW_PR_TOOLING_ROOT",
    source === "env" ? "alias" : source === "missing" || source === "installed" ? root : "",
  );
  if (source === "installed" || source === "configured") {
    if (source === "installed") {
      mkdirSync(join(checkout, "node_modules"));
    } else {
      vi.stubEnv("PNPM_CONFIG_MODULES_DIR", join(tooling, "node_modules"));
    }
    expect(toolingDependencyOptions(checkout, "watch-pr-ci")).toEqual({});
    expect(notice).not.toHaveBeenCalled();
  } else if (reason) {
    expect(() => toolingDependencyOptions(checkout, "watch-pr-ci")).toThrow(reason);
    expect(notice).not.toHaveBeenCalled();
  } else {
    toolingDependencyOptions(checkout, "watch-pr-ci");
    expect(notice).toHaveBeenCalledExactlyOnceWith(
      `[watch-pr-ci] resolving missing packages from scripts/pr tooling root ${source === "config" ? tooling : canonical}`,
    );
  }
  expect(existsSync(join(checkout, "node_modules"))).toBe(source === "installed");
});

it("checks fallback versions before loading through the watcher child and preserves local resolution", () => {
  const root = tempDirs.make("openclaw-watch-dependencies-");
  const checkout = join(root, "checkout");
  const tooling = join(root, "tooling #root");
  const lib = join(checkout, "scripts", "lib");
  mkdirSync(lib, { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  };
  for (const directory of [checkout, tooling]) {
    git("init", "--quiet", directory);
    git("-C", directory, "remote", "add", "origin", "https://github.com/openclaw/openclaw.git");
  }
  const manifest = {
    dependencies: { "fixture-pkg": "1.0.0" },
    devDependencies: { "dev-pkg": "1.0.0" },
    optionalDependencies: { "@fixture/scoped": "1.0.0" },
    imports: { "#source": "./scripts/local-source.mjs" },
  };
  writeJson(join(checkout, "package.json"), manifest);
  for (const file of [
    "tsx-cli-shim.mjs",
    "local-check-runtime.mts",
    "tooling-dependencies.mjs",
    "managed-cleanup-handoff.mts",
    "../watch-pr-ci.mjs",
  ]) {
    copyFileSync(resolve("scripts/lib", file), join(lib, file));
  }
  writePackage(tooling, "fixture-pkg", "tooling");
  writePackage(root, "fixture-pkg", "stale ancestor", "0.0.0-stale");
  writePackage(tooling, "dev-pkg", "dev");
  writePackage(tooling, "@fixture/scoped", "scoped", "1.0.0", { "./subpath": "./index.mjs" });
  writePackage(tooling, "local-pkg", "fallback", "1.0.0", {
    ".": "./index.mjs",
    "./private": "./index.mjs",
  });
  writePackage(join(checkout, "scripts"), "local-pkg", "local");
  writeFileSync(join(tooling, "relative.mjs"), 'export default "wrong";\n');
  writeFileSync(join(checkout, "scripts/local-source.mjs"), 'export default "source";\n');
  writeFileSync(
    join(checkout, "scripts/watch-pr-ci.mts"),
    `import assert from "node:assert/strict";
import missing from "fixture-pkg";
import dev from "dev-pkg";
import scoped from "@fixture/scoped/subpath";
import local from "local-pkg";
import source from "#source";
assert.deepEqual({ missing, dev, scoped, local, source }, {
  missing: "tooling", dev: "dev", scoped: "scoped", local: "local", source: "source",
});
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
    // Configured modules directories select the link path instead of the fallback.
    PNPM_CONFIG_MODULES_DIR: undefined,
    pnpm_config_modules_dir: undefined,
    npm_config_modules_dir: undefined,
  };
  const run = () =>
    spawnSync(requireNodeTool("node"), [join(checkout, "scripts/watch-pr-ci.mjs")], {
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
      writeJson(join(checkout, "package.json"), { ...manifest, dependencies: {} });
      rmSync(join(root, "node_modules/fixture-pkg"), { recursive: true });
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
