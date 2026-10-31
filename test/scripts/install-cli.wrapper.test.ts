import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.each(["npm", "git"])("%s private CLI launcher", (method) => {
  it.each(["ordinary", "literal $HOME ' quote \" and `backticks` & !"])(
    "runs from another directory with literal paths: %s",
    (name) => {
      const home = tempDirs.make("openclaw-wrapper-");
      const prefix = join(home, name);
      const repo = join(home, `checkout ${name}`);
      const nodeDir = join(prefix, "tools", "node-v24.22.1");
      const npmPackage = join(nodeDir, "lib", "node_modules", "openclaw");
      const fixture = `if (process.argv[2] === "--version") console.log("2026.11.4");
else console.log(JSON.stringify(process.argv.slice(2)));`;
      for (const entry of [join(npmPackage, "dist"), join(repo, "dist")]) {
        mkdirSync(entry, { recursive: true });
        writeFileSync(join(entry, "entry.js"), fixture);
      }
      mkdirSync(join(repo, ".git"));
      mkdirSync(join(nodeDir, "bin"), { recursive: true });
      symlinkSync(process.execPath, join(nodeDir, "bin", "node"));
      symlinkSync("node-v24.22.1", join(prefix, "tools", "node"));
      writeFileSync(
        join(nodeDir, "bin", "npm"),
        `#!/bin/bash
case "$1" in
  --version) printf '11.15.0\n' ;;
  config) printf 'null\n' ;;
  install) exit 0 ;;
  *) exit 91 ;;
esac
`,
        { mode: 0o755 },
      );
      const result = spawnSync(
        "/bin/bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          `
        source "$INSTALLER"
        install_node() { :; }
        ensure_git() { :; }; ensure_pnpm() { :; }; run_pnpm() { :; }
        git() {
          if [[ "$*" == *status* ]]; then printf ' M package.json\n'; fi
          return 0
        }
        main --runtime-only --install-method "$METHOD" --prefix "$PREFIX_FIXTURE" --git-dir "$REPO_FIXTURE"
      `,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            TMPDIR: home,
            BASH_ENV: "",
            ENV: "",
            OPENCLAW_INSTALL_CLI_SH_NO_RUN: "1",
            INSTALLER: join(process.cwd(), "scripts/install-cli.sh"),
            METHOD: method,
            PREFIX_FIXTURE: prefix,
            REPO_FIXTURE: repo,
          },
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("OpenClaw installed (2026.11.4)");
      const args = ["argument with spaces", "$HOME", "'\"`&!", ""];
      const launched = spawnSync(join(prefix, "bin", "openclaw"), args, {
        cwd: home,
        encoding: "utf8",
        env: { ...process.env, BASH_ENV: "", ENV: "" },
      });
      expect(launched.status, launched.stderr).toBe(0);
      expect(JSON.parse(launched.stdout)).toEqual(args);
    },
  );
});
