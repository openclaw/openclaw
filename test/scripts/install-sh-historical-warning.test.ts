import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runner = readFileSync("scripts/docker/install-sh-smoke/run.sh", "utf8");
const start = runner.indexOf("verify_historical_self_update_warning() {");
const callerStart = runner.indexOf("run_update_candidate() {");
const end = runner.indexOf("\nrun_npm_global_smoke()", callerStart);
const functions = runner.slice(start < 0 ? callerStart : start, end);
const verifyPath = path.resolve("scripts/docker/install-sh-common/cli-verify.sh");
const historicalWarning =
  "Your OpenClaw config was written by version 2026.9.5, but this command is running 2026.9.4.";
const posixIt = process.platform === "win32" ? it.skip : it;

type Fixture = {
  freshVersion?: string;
  freshWarning?: string;
  freshExit?: number;
  updateWarning?: string;
  updateExit?: number;
  manifestVersion?: string;
  foreignPath?: boolean;
  afterVersion?: string;
  beforeVersion?: string;
  baseline?: string;
  globalExit?: number;
};

function runFixture(options: Fixture = {}) {
  const root = tempDirs.make("installer-historical-warning-");
  const bin = path.join(root, "bin");
  const npmRoot = path.join(root, "global");
  const packageRoot = path.join(npmRoot, "openclaw");
  mkdirSync(bin);
  mkdirSync(packageRoot, { recursive: true });
  const cli = path.join(packageRoot, "openclaw.mjs");
  const body = `#!/usr/bin/env bash
case "$1" in
  update) cat "$PAYLOAD"; printf '%s\\n' "$UPDATE_WARNING" >&2; exit "$UPDATE_EXIT" ;;
  --version) printf 'OpenClaw %s\\n' "$FRESH_VERSION"; printf '%s' "$FRESH_WARNING" >&2; exit "$FRESH_EXIT" ;;
  --help) printf 'fresh-help\\n' >> "$HELP_MARKER" ;;
  *) exit 90 ;;
esac
`;
  writeFileSync(cli, body, { mode: 0o755 });
  if (options.foreignPath) {
    writeFileSync(path.join(bin, "openclaw"), body, { mode: 0o755 });
  } else {
    symlinkSync(cli, path.join(bin, "openclaw"));
  }
  writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: options.manifestVersion ?? "2026.9.5",
      bin: { openclaw: "openclaw.mjs" },
    }),
  );
  const payload = path.join(root, "payload.json");
  const url = "https://candidate.invalid/candidate.tgz";
  writeFileSync(
    payload,
    JSON.stringify({
      status: "ok",
      before: { version: options.beforeVersion ?? "2026.9.4" },
      after: { version: options.afterVersion ?? "2026.9.5" },
      steps: [
        { name: "global update", exitCode: options.globalExit ?? 0, command: `npm install ${url}` },
        { name: "openclaw doctor", exitCode: 0 },
      ],
    }),
  );
  const result = spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `set -euo pipefail
source ${JSON.stringify(verifyPath)}
${functions}
quiet_npm() { printf '%s\\n' "$FAKE_NPM_ROOT"; }
run_with_heartbeat() { shift; "$@"; }
print_install_audit() { :; }
allow_legacy_update_warning() { return 1; }
run_update_candidate "$BASELINE" applied --no-restart
`,
    ],
    {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: root,
        PACKAGE_NAME: "openclaw",
        UPDATE_EXPECT_VERSION: "2026.9.5",
        UPDATE_TAG_URL: url,
        BASELINE: options.baseline ?? "2026.9.4",
        PAYLOAD: payload,
        FAKE_NPM_ROOT: npmRoot,
        UPDATE_WARNING: options.updateWarning ?? historicalWarning,
        UPDATE_EXIT: String(options.updateExit ?? 0),
        FRESH_VERSION: options.freshVersion ?? "2026.9.5",
        FRESH_WARNING: options.freshWarning ?? "",
        FRESH_EXIT: String(options.freshExit ?? 0),
        HELP_MARKER: path.join(root, "fresh-help"),
      },
    },
  );
  return result;
}

describe("published 9.4 installer warning after verified 9.5 update", () => {
  posixIt("accepts only after the real fresh CLI and global package agree", () => {
    const result = runFixture();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("cli=openclaw installed=2026.9.5 expected=2026.9.5");
    expect(result.stderr).toContain("fresh PATH and global install verified as 2026.9.5");
    expect(result.stderr).toContain(historicalWarning);
  });

  const negatives: Array<{ name: string; fixture: Fixture }> = [
    { name: "stale PATH executable", fixture: { freshVersion: "2026.9.4" } },
    { name: "foreign PATH executable with matching version", fixture: { foreignPath: true } },
    { name: "stale global package", fixture: { manifestVersion: "2026.9.4" } },
    { name: "fresh process failure", fixture: { freshExit: 4 } },
    {
      name: "fresh process future-config warning",
      fixture: {
        freshWarning:
          "Your OpenClaw config was written by version 2026.9.6, but this command is running 2026.9.5.",
      },
    },
    { name: "nonzero updater exit", fixture: { updateExit: 7 } },
    { name: "failed global update step", fixture: { globalExit: 1 } },
    { name: "wrong JSON after version", fixture: { afterVersion: "2026.9.4" } },
    { name: "wrong JSON before version", fixture: { beforeVersion: "2026.9.3" } },
    {
      name: "unproved historical baseline",
      fixture: {
        baseline: "2026.9.3",
        beforeVersion: "2026.9.3",
        updateWarning: historicalWarning.replace("running 2026.9.4", "running 2026.9.3"),
      },
    },
    {
      name: "additional future-config warning",
      fixture: {
        updateWarning: `${historicalWarning}\nYour OpenClaw config was written by version 2026.9.6, but this command is running 2026.9.4.`,
      },
    },
    {
      name: "duplicate warning",
      fixture: { updateWarning: `${historicalWarning}\n${historicalWarning}` },
    },
  ];
  posixIt.each(negatives)("rejects $name", ({ fixture }) => {
    const result = runFixture(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain("fresh PATH and global install verified");
  });
});
