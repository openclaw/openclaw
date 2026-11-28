import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  hasPublishedPnpmLauncherRepairWork,
  repairPublishedPnpmLaunchers,
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
function publishedShim(
  home: string,
  recorded: string,
  entry = `${GROUP}/node_modules/openclaw/openclaw.mjs`,
  nodePath = `${home}/${STAGE}/${GROUP}/node_modules/.pnpm/node_modules`,
) {
  const target = quoted(`../${STAGE}/${entry}`);
  return [
    "#!/bin/sh",
    'basedir_abs=$(CDPATH= cd -P -- "$(dirname "$0")" && pwd -P) || exit $?',
    'basedir="$basedir_abs"',
    'basedir_win="$basedir"',
    `export NODE_PATH=${quoted(nodePath)}`,
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
        // A custom global directory name is found through PNPM_HOME, not the path layout.
        const env = { PNPM_HOME: home, PATH: path.join(base, "fifo-bin") };
        const launcherFacts = async () => {
          const stat = await fs.stat(launcher, { bigint: true });
          return [await fs.readFile(launcher, "utf8"), stat.mtimeNs, stat.ino, stat.mode];
        };
        const stale = await launcherFacts();
        // Doctor's pending check reads the same facts and changes nothing.
        await expect(hasPublishedPnpmLauncherRepairWork({ root: packageRoot, env })).resolves.toBe(
          true,
        );
        expect(await launcherFacts()).toEqual(stale);
        expect((await fs.readdir(path.dirname(launcher))).toSorted()).toEqual(["node", "openclaw"]);

        const { repaired, failed } = await repairPublishedPnpmLaunchers({ root: packageRoot, env });

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
        await expect(repairPublishedPnpmLaunchers({ root: packageRoot, env })).resolves.toEqual({
          repaired: [],
          failed: [],
        });
        await expect(hasPublishedPnpmLauncherRepairWork({ root: packageRoot, env })).resolves.toBe(
          false,
        );
        expect((await fs.readdir(path.dirname(launcher))).toSorted()).toEqual(["node", "openclaw"]);
      }),
  );

  it("repairs a pnpm 11 grouped launcher from the Gateway's real package path without PNPM_HOME", async () =>
    withTestDir({ prefix: "launcher-repair-pnpm11-" }, async (base) => {
      // Captured after a pnpm 11.28.13 update: the hash link selects a group whose
      // project-local `.pnpm` store holds the package, and NODE_PATH names that live group.
      const { home, launcher } = await pnpmHome(base);
      const hashEntry = path.join(home, "global", "v11", "9440847f");
      const group = path.join(home, "global", "v11", "708-1a1f51a997e");
      const realRoot = path.join(group, ".pnpm", "openclaw@2026.11.6", "node_modules", "openclaw");
      await fs.mkdir(realRoot, { recursive: true });
      await fs.writeFile(path.join(realRoot, "openclaw.mjs"), "");
      await fs.mkdir(path.join(group, "node_modules"));
      await fs.symlink(realRoot, path.join(group, "node_modules", "openclaw"));
      await fs.symlink(group, hashEntry);
      const recorded = path.join(hashEntry, "node_modules", "openclaw", "openclaw.mjs");
      const nodePath = path.join(group, ".pnpm", "openclaw@2026.11.6", "node_modules");
      await fs.writeFile(
        launcher,
        publishedShim(home, recorded, "v11/9440847f/node_modules/openclaw/openclaw.mjs", nodePath),
        { mode: 0o755 },
      );
      await expect(runFile(launcher)).rejects.toThrow();

      // The Gateway knows only its real path; pnpm's home comes from that path's layout.
      const { repaired, failed } = await repairPublishedPnpmLaunchers({
        root: realRoot,
        env: { PATH: path.join(base, "empty-path") },
      });

      expect(failed).toEqual([]);
      expect(repaired).toEqual([
        expect.objectContaining({ file: launcher, stage: path.join(home, STAGE) }),
      ]);
      const [entry, liveNodePath] = (await runFile(launcher)).stdout.split("\n");
      expect([path.resolve(entry ?? ""), liveNodePath]).toEqual([recorded, nodePath]);
    }));

  it("leaves another account's launcher unchanged and reports why", async () =>
    withTestDir({ prefix: "launcher-repair-owner-" }, async (base) => {
      const { home, packageRoot, launcher } = await pnpmHome(base);
      const before = await fs.readFile(launcher, "utf8");
      const owner = (await fs.stat(launcher)).uid;
      // This process now runs as a different account than the launcher's owner.
      vi.spyOn(process, "getuid").mockReturnValue(owner + 1);

      const { repaired, failed } = await repairPublishedPnpmLaunchers({
        root: packageRoot,
        env: { PNPM_HOME: home },
      });

      expect(repaired).toEqual([]);
      expect(failed).toEqual([{ file: launcher, error: expect.any(Error) }]);
      expect(String(failed[0]?.error)).toContain(
        `belongs to uid ${owner}, not this account (uid ${owner + 1}); it was left unchanged`,
      );
      expect(await fs.readFile(launcher, "utf8")).toBe(before);
      expect((await fs.readdir(path.dirname(launcher))).toSorted()).toEqual(["node", "openclaw"]);
    }));

  it("never carries set-ID bits into the repaired launcher", async () =>
    withTestDir({ prefix: "launcher-repair-setid-" }, async (base) => {
      const { home, packageRoot, launcher } = await pnpmHome(base);
      await fs.chmod(launcher, 0o4755);
      expect((await fs.stat(launcher)).mode & 0o7777).toBe(0o4755);

      const { repaired, failed } = await repairPublishedPnpmLaunchers({
        root: packageRoot,
        env: { PNPM_HOME: home },
      });

      expect(failed).toEqual([]);
      expect(repaired).toHaveLength(1);
      expect((await fs.stat(launcher)).mode & 0o7777).toBe(0o755);
    }));

  it("relocates a lexical shim from the bin path its shell and detection use", async () =>
    withTestDir({ prefix: "launcher-repair-lexical-" }, async (base) => {
      // pnpm 10 shims resolve `$basedir` lexically. Here `bin` is a link into a directory
      // two levels deeper, so the physical directory would resolve `../` elsewhere.
      const { home, packageRoot, launcher } = await pnpmHome(base);
      const realBin = path.join(base, "elsewhere", "deeper", "bin");
      await fs.mkdir(path.dirname(realBin), { recursive: true });
      await fs.rename(path.join(home, "bin"), realBin);
      await fs.symlink(realBin, path.join(home, "bin"));
      const target = `../${STAGE}/${GROUP}/node_modules/openclaw/openclaw.mjs`;
      await fs.writeFile(
        path.join(realBin, "openclaw"),
        [
          "#!/bin/sh",
          'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
          `exec "$basedir/node"  "$basedir/${target}" "$@"`,
          `# cmd-shim-target=${path.join(packageRoot, "openclaw.mjs")}`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      const { repaired, failed } = await repairPublishedPnpmLaunchers({
        root: packageRoot,
        env: { PNPM_HOME: home },
      });

      expect(failed).toEqual([]);
      expect(repaired).toEqual([expect.objectContaining({ file: launcher })]);
      // Node resolves its entry argument lexically, from the bin path the shell reached.
      const live = `../global/${GROUP}/node_modules/openclaw/openclaw.mjs`;
      expect(await fs.readFile(launcher, "utf8")).toContain(`"\${basedir}"/${live} `);
      expect(path.resolve(home, "bin", live)).toBe(path.join(packageRoot, "openclaw.mjs"));
    }));

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
        hasPublishedPnpmLauncherRepairWork({ root, env: { PNPM_HOME: home } }),
      ).resolves.toBe(false);
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
