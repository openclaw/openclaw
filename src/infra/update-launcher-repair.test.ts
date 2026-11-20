import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { repairPublishedPnpmLaunchers } from "./update-launcher-repair.js";

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

async function pnpmHome(base: string, globalName = "global", homeName = "pnpm-home") {
  await fs.mkdir(path.join(base, homeName), { recursive: true });
  const home = await fs.realpath(path.join(base, homeName));
  const packageRoot = path.join(home, globalName, GROUP, "node_modules", "openclaw");
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "openclaw.mjs"),
    'console.log("live 2026.11.5", process.env.NODE_PATH ?? "");\n',
  );
  await fs.mkdir(path.join(home, "bin"));
  // The shim prefers `$basedir/node`; this one reports exactly what the shell passed it.
  await fs.writeFile(
    path.join(home, "bin", "node"),
    `#!/bin/sh\n[ -e "$1" ] || { echo "missing: $1" >&2; exit 1; }\nprintf '%s\\n%s\\n' "$1" "$NODE_PATH"\n`,
    { mode: 0o755 },
  );
  const launcher = path.join(home, "bin", "openclaw");
  const recorded = path.join(packageRoot, "openclaw.mjs");
  await fs.writeFile(launcher, publishedShim(home, recorded), { mode: 0o755 });
  return { home, packageRoot, launcher };
}

describe.skipIf(process.platform === "win32")("staged launcher repair", () => {
  it.each([
    ["global", "pnpm-home"],
    // An apostrophe below the pnpm home: the live target and NODE_PATH need `'\''`.
    ["team's global", "pnpm-home"],
    // An apostrophe above it: pnpm spells the stage itself with `'\''` in NODE_PATH.
    ["global", "team's base/pnpm-home"],
    // Every character a single-quoted word carries literally; `$'` is also a JS replacement token.
    [`odd "dir" $HOME $' \\ global`, "pnpm-home"],
  ])(
    "rewrites a launcher left pointing at the removed stage to the live install (%s under %s)",
    async (globalName, homeName) =>
      withTestDir({ prefix: "launcher-repair-" }, async (base) => {
        const { home, packageRoot, launcher } = await pnpmHome(base, globalName, homeName);
        await expect(runFile(launcher)).rejects.toThrow();
        // A FIFO with no writer on PATH would block any reader; the scan must skip it.
        await fs.mkdir(path.join(base, "fifo-bin"));
        await runFile("mkfifo", [path.join(base, "fifo-bin", "openclaw")]);

        const { repaired, failed } = await repairPublishedPnpmLaunchers({
          root: packageRoot,
          // A custom global directory name is found through PNPM_HOME, not the path layout.
          env: { PNPM_HOME: home, PATH: path.join(base, "fifo-bin") },
        });

        expect(failed).toEqual([]);
        expect(repaired).toEqual([
          expect.objectContaining({ file: launcher, stage: path.join(home, STAGE) }),
        ]);
        // The repaired shim still parses as shell and hands the exact live paths to node.
        const { stdout } = await runFile(launcher);
        const live = path.join(home, globalName, GROUP, "node_modules");
        const [entry, nodePath, end] = stdout.split("\n");
        expect([path.resolve(entry ?? ""), nodePath, end]).toEqual([
          path.join(live, "openclaw", "openclaw.mjs"),
          path.join(live, ".pnpm", "node_modules"),
          "",
        ]);
        expect((await fs.stat(launcher)).mode & 0o777).toBe(0o755);
        expect(await fs.readFile(launcher, "utf8")).not.toContain(STAGE);
        // Repaired once; a second pass finds a current launcher and leaves no staging behind.
        await expect(
          repairPublishedPnpmLaunchers({
            root: packageRoot,
            env: { PNPM_HOME: home, PATH: path.join(base, "fifo-bin") },
          }),
        ).resolves.toEqual({ repaired: [], failed: [] });
        expect((await fs.readdir(path.dirname(launcher))).toSorted()).toEqual(["node", "openclaw"]);
      }),
  );

  it.each([
    "stage still present",
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

      // PNPM_HOME presents the launcher in every case, so each guard must refuse it.
      await expect(
        repairPublishedPnpmLaunchers({ root, env: { PNPM_HOME: home } }),
      ).resolves.toEqual({
        repaired: [],
        failed: [],
      });
      expect(await fs.readFile(launcher, "utf8")).toBe(before);
    }),
  );
});
