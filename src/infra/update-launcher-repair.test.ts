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
const STAGE = ".openclaw-update-native-lgohdt";
const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * The live launcher an earlier updater published, as captured after a pnpm
 * `2026.11.4 -> 2026.11.5` update: every exec line and NODE_PATH name the removed
 * stage, and only the `cmd-shim-target` comment names the live install.
 */
function publishedShim(home: string, recorded: string) {
  const target = quoted(`../${STAGE}/${GROUP}/node_modules/openclaw/openclaw.mjs`);
  return [
    "#!/bin/sh",
    'basedir_abs=$(CDPATH= cd -P -- "$(dirname "$0")" && pwd -P) || exit $?',
    'basedir="$basedir_abs"',
    'basedir_win="$basedir"',
    `export NODE_PATH=${quoted(`${home}/${STAGE}/${GROUP}/node_modules/.pnpm/node_modules`)}`,
    'if [ -x "$basedir/node" ]; then',
    `  exec "$basedir/node"  "$basedir_abs"/${target} "$@"`,
    "elif command -v node >/dev/null 2>&1; then",
    `  exec node  "$basedir_abs"/${target} "$@"`,
    "else",
    `  exec node  "$basedir_win"/${target} "$@"`,
    "fi",
    `# cmd-shim-target=${recorded}`,
    "",
  ].join("\n");
}

async function pnpmHome(base: string, globalName = "global") {
  await fs.mkdir(path.join(base, "pnpm-home"));
  const home = await fs.realpath(path.join(base, "pnpm-home"));
  const packageRoot = path.join(home, globalName, GROUP, "node_modules", "openclaw");
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "openclaw.mjs"),
    'console.log("live 2026.11.5", process.env.NODE_PATH ?? "");\n',
  );
  await fs.mkdir(path.join(home, "bin"));
  const launcher = path.join(home, "bin", "openclaw");
  const recorded = path.join(packageRoot, "openclaw.mjs");
  await fs.writeFile(launcher, publishedShim(home, recorded), { mode: 0o755 });
  return { home, packageRoot, launcher };
}

describe.skipIf(process.platform === "win32")("staged launcher repair", () => {
  it.each(["global", "team's global"])(
    "rewrites a launcher left pointing at the removed stage to the live install (%s)",
    async (globalName) =>
      withTestDir({ prefix: "launcher-repair-" }, async (base) => {
        const { home, packageRoot, launcher } = await pnpmHome(base, globalName);
        await expect(runFile(launcher)).rejects.toThrow();

        const { repaired, failed } = await repairPublishedPnpmLaunchers({
          root: packageRoot,
          // A custom global directory name is found through PNPM_HOME, not the path layout.
          env: { PNPM_HOME: home },
        });

        expect(failed).toEqual([]);
        expect(repaired).toEqual([
          expect.objectContaining({ file: launcher, stage: path.join(home, STAGE) }),
        ]);
        // The repaired shim still parses as shell, quotes the live path, and runs it.
        const { stdout } = await runFile(launcher);
        expect(stdout.trim()).toBe(
          `live 2026.11.5 ${path.join(home, globalName, GROUP, "node_modules/.pnpm/node_modules")}`,
        );
        expect((await fs.stat(launcher)).mode & 0o777).toBe(0o755);
        expect(await fs.readFile(launcher, "utf8")).not.toContain(STAGE);
        // Repaired once; a second pass finds a current launcher and leaves no staging behind.
        await expect(repairStagedRuntimeLauncher(launcher)).resolves.toEqual({
          outcome: "current",
        });
        expect(await fs.readdir(path.dirname(launcher))).toEqual(["openclaw"]);
      }),
  );

  it.each([
    "stage still present",
    "recorded target missing",
    "another installation",
    "recorded target elsewhere",
    "stage not beside the project",
  ] as const)("leaves a launcher it cannot prove is this installation's (%s)", async (scenario) =>
    withTestDir({ prefix: "launcher-repair-refuse-" }, async (base) => {
      const { home, packageRoot, launcher } = await pnpmHome(base);
      let root = packageRoot;
      if (scenario === "stage still present") {
        // A live stage belongs to an update in progress, not a leftover.
        await fs.mkdir(path.join(home, STAGE));
      } else if (scenario === "recorded target missing") {
        await fs.rm(path.join(packageRoot, "openclaw.mjs"));
      } else if (scenario === "another installation") {
        root = path.join(base, "other", "openclaw");
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(path.join(root, "openclaw.mjs"), "");
      } else {
        // The recorded entry is this installation's, but not the stage's live counterpart.
        const moved =
          scenario === "recorded target elsewhere"
            ? path.join(home, "global", "v11", "other-group", "openclaw.mjs")
            : path.join(base, "elsewhere", GROUP, "node_modules", "openclaw", "openclaw.mjs");
        await fs.mkdir(path.dirname(moved), { recursive: true });
        await fs.rename(path.join(packageRoot, "openclaw.mjs"), moved);
        root = path.dirname(moved);
        const content = await fs.readFile(launcher, "utf8");
        await fs.writeFile(
          launcher,
          content.replace(/# cmd-shim-target=.*/u, `# cmd-shim-target=${moved}`),
        );
      }
      const before = await fs.readFile(launcher, "utf8");

      await expect(repairPublishedPnpmLaunchers({ root, env: {} })).resolves.toEqual({
        repaired: [],
        failed: [],
      });
      expect(await fs.readFile(launcher, "utf8")).toBe(before);
    }),
  );
});
