import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  ["update", "plan", "--json"],
  ["--update", "plan", "--json"],
  ["update", "plan", "--help"],
  ["update", "--tag", "latest", "plan", "--json"],
  ["update", "--channel", "stable", "plan", "--help"],
])(
  "dispatches passive planning %j before runtime repair, package hooks, and compile-cache writes",
  async (...args) => {
    const root = dirs.make("openclaw-recipe-launcher-");
    await fs.mkdir(path.join(root, "dist", "infra"), { recursive: true });
    await Promise.all(
      [
        "openclaw.mjs",
        "cli-root-options.mjs",
        "node-compile-cache.mjs",
        "node-host-launcher.mjs",
        "node-runtime-recovery.mjs",
        "node-runtime-env.mjs",
        "node-version.mjs",
        "node-sqlite.mjs",
        "gateway-run-argv.mjs",
        "gateway-shutdown-budget.mjs",
      ].map((name) => fs.copyFile(path.resolve(name), path.join(root, name))),
    );
    await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
    await fs.writeFile(path.join(root, ".openclaw-lifecycle-pending"), "pending");
    await fs.writeFile(
      path.join(root, "dist", "infra", "package-lifecycle.js"),
      'throw new Error("Planning executed a package lifecycle hook");',
    );
    await fs.writeFile(
      path.join(root, "dist", "entry.js"),
      'process.stdout.write(JSON.stringify({kind:"report-only",mutationEnabled:false}) + "\\n");',
    );
    await fs.writeFile(
      path.join(root, "node-runtime-update.mjs"),
      'throw new Error("Planning attempted runtime repair");',
    );
    const preload = path.join(root, "preload.mjs");
    await fs.writeFile(
      preload,
      'import module from "node:module";\n' +
        'Object.defineProperty(process.versions, "node", {value:"20.0.0"});\n' +
        'module.enableCompileCache = () => { throw new Error("Planning enabled compile cache"); };\n',
    );
    const result = spawnSync(
      resolveTestNodeExecPath(),
      ["--import", preload, path.join(root, "openclaw.mjs"), ...args],
      { encoding: "utf8", timeout: 10_000, env: { ...process.env, HOME: root, USERPROFILE: root } },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ kind: "report-only", mutationEnabled: false });
    expect(result.stderr).toBe("");
    expect(await fs.readFile(path.join(root, ".openclaw-lifecycle-pending"), "utf8")).toBe(
      "pending",
    );
  },
);
