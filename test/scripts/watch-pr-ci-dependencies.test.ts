import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { toolingDependencyOptions } from "../../scripts/lib/tooling-dependencies.mjs";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createToolingDependencyFixture } from "./tooling-dependencies.test-support.mts";

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

it("loads fallback dependencies through the watcher child and preserves local resolution", () => {
  const root = tempDirs.make("openclaw-watch-dependencies-");
  const { checkout, tooling, writePackage } = createToolingDependencyFixture(root, true);
  const manifest = {
    dependencies: { "fixture-pkg": "1.0.0" },
    optionalDependencies: { "@fixture/scoped": "1.0.0" },
    imports: { "#source": "./scripts/local-source.mjs" },
  };
  writeJson(join(checkout, "package.json"), manifest);
  copyFileSync("scripts/watch-pr-ci.mjs", join(checkout, "scripts/watch-pr-ci.mjs"));
  writePackage("fixture-pkg", 'export default "tooling";');
  writePackage("@fixture/scoped", 'export default "scoped";', "1.0.0", tooling, {
    "./subpath": 'export { default } from "./index.mjs";',
  });
  writePackage("local-pkg", 'export default "fallback";');
  writePackage("local-pkg", 'export default "local";', "1.0.0", join(checkout, "scripts"));
  writeFileSync(join(tooling, "relative.mjs"), 'export default "wrong";\n');
  writeFileSync(join(checkout, "scripts/local-source.mjs"), 'export default "source";\n');
  writeFileSync(
    join(checkout, "scripts/watch-pr-ci.mts"),
    `import assert from "node:assert/strict";
import missing from "fixture-pkg";
import scoped from "@fixture/scoped/subpath";
import local from "local-pkg";
import source from "#source";
assert.deepEqual({ missing, scoped, local, source }, {
  missing: "tooling", scoped: "scoped", local: "local", source: "source",
});
for (const specifier of ["./relative.mjs", new URL("./relative.mjs", import.meta.url).href]) {
  await assert.rejects(import(specifier), { code: "ERR_MODULE_NOT_FOUND" });
}
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
  expect(existsSync(join(checkout, "node_modules"))).toBe(false);
});
