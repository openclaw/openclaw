import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  repairPublishedPnpmLaunchers,
  repairStagedRuntimeLauncher,
} from "./update-launcher-repair.js";

const runFile = promisify(execFile);
const GROUP = "v11/926ea0a51a5e60b563a5c9f5e53c1fda01ec614676ee4355740d8c425a806cdb";

/**
 * The live pnpm 12.15+ launcher an earlier updater published, as captured after a
 * `2026.11.4 -> 2026.11.5` pnpm update: every exec line names the removed stage, and
 * only the `cmd-shim-target` comment names the live install.
 */
function publishedShim(stage: string, home: string) {
  const target = `../${stage}/${GROUP}/node_modules/openclaw/openclaw.mjs`;
  return [
    "#!/bin/sh",
    'basedir_abs=$(CDPATH= cd -P -- "$(dirname "$0")" && pwd -P) || exit $?',
    'basedir="$basedir_abs"',
    'basedir_win="$basedir"',
    'if [ -x "$basedir/node" ]; then',
    `  exec "$basedir/node"  "$basedir_abs"/'${target}' "$@"`,
    "elif command -v node >/dev/null 2>&1; then",
    `  exec node  "$basedir_abs"/'${target}' "$@"`,
    "else",
    `  exec node  "$basedir_win"/'${target}' "$@"`,
    "fi",
    `# cmd-shim-target=${home}/global/${GROUP}/node_modules/openclaw/openclaw.mjs`,
    "",
  ].join("\n");
}

async function pnpmHome(base: string) {
  const home = path.join(base, "pnpm-home");
  const packageRoot = path.join(home, "global", GROUP, "node_modules", "openclaw");
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, "openclaw.mjs"), 'console.log("live 2026.11.5");\n');
  await fs.mkdir(path.join(home, "bin"));
  const launcher = path.join(home, "bin", "openclaw");
  await fs.writeFile(launcher, publishedShim(".openclaw-update-native-lgohdt", home), {
    mode: 0o755,
  });
  return { home, packageRoot, launcher };
}

describe.skipIf(process.platform === "win32")("staged launcher repair", () => {
  it("rewrites a launcher left pointing at the removed stage to the live install", async () =>
    withTestDir({ prefix: "launcher-repair-" }, async (base) => {
      const { home, packageRoot, launcher } = await pnpmHome(base);
      await expect(runFile(launcher)).rejects.toThrow();

      const repairs = await repairPublishedPnpmLaunchers({ root: packageRoot, env: {} });

      expect(repairs).toEqual([
        expect.objectContaining({
          outcome: "repaired",
          file: launcher,
          stage: path.join(await fs.realpath(home), ".openclaw-update-native-lgohdt"),
        }),
      ]);
      expect((await runFile(launcher)).stdout.trim()).toBe("live 2026.11.5");
      expect((await fs.stat(launcher)).mode & 0o777).toBe(0o755);
      expect(await fs.readFile(launcher, "utf8")).not.toContain(".openclaw-update-native-");
      // Repaired once; a second pass finds a current launcher and leaves it alone.
      await expect(repairStagedRuntimeLauncher(launcher)).resolves.toEqual({ outcome: "current" });
      expect(await fs.readdir(path.dirname(launcher))).toEqual(["openclaw"]);
    }));

  it.each(["stage still present", "recorded target missing", "another installation"] as const)(
    "leaves a launcher it cannot prove is this installation's (%s)",
    async (scenario) =>
      withTestDir({ prefix: "launcher-repair-refuse-" }, async (base) => {
        const { home, packageRoot, launcher } = await pnpmHome(base);
        let root = packageRoot;
        if (scenario === "stage still present") {
          // A live stage belongs to an update in progress, not a leftover.
          await fs.mkdir(path.join(home, ".openclaw-update-native-lgohdt"));
        } else if (scenario === "recorded target missing") {
          await fs.rm(path.join(packageRoot, "openclaw.mjs"));
        } else {
          root = path.join(base, "other", "openclaw");
          await fs.mkdir(root, { recursive: true });
          await fs.writeFile(path.join(root, "openclaw.mjs"), "");
        }
        const before = await fs.readFile(launcher, "utf8");

        await expect(repairPublishedPnpmLaunchers({ root, env: {} })).resolves.toEqual([]);
        expect(await fs.readFile(launcher, "utf8")).toBe(before);
      }),
  );
});
