import { spawnSync } from "node:child_process";
// Release preflight tests keep generated-artifact checks fail-closed for operators.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const SCRIPT = "scripts/release-preflight.mjs";
const CHECK_COMMANDS = [
  "deps:root-ownership:check",
  "deps:shrinkwrap:check",
  "plugins:sync:check",
  "plugins:inventory:check",
  "config:schema:check",
  "config:channels:check",
  "config:docs:check",
  "plugin-sdk:check-exports",
  "plugin-sdk:api:check",
  "plugin-sdk:surface:check",
];
const FIX_COMMANDS = [
  "plugins:sync",
  "deps:shrinkwrap:changed:generate",
  "plugins:inventory:gen",
  "config:schema:gen",
  "config:channels:gen",
  "config:docs:gen",
  "plugin-sdk:sync-exports",
  "plugin-sdk:api:gen",
];

const tempDirs = new Set<string>();

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function makeFakePnpm(): { binDir: string; logPath: string } {
  const root = makeTempDir(tempDirs, "openclaw-release-preflight-");
  const binDir = join(root, "bin");
  const logPath = join(root, "pnpm.log");
  mkdirSync(binDir);
  const pnpmPath = join(binDir, "pnpm");
  writeFileSync(
    pnpmPath,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const command = process.argv.slice(2).join(" ");
appendFileSync(process.env.OPENCLAW_RELEASE_PREFLIGHT_PNPM_LOG, command + "\\n");
const failures = new Set((process.env.OPENCLAW_RELEASE_PREFLIGHT_FAIL_COMMANDS ?? "").split(";").filter(Boolean));
process.exit(failures.has(command) ? 7 : 0);
`,
    { mode: 0o755 },
  );
  chmodSync(pnpmPath, 0o755);
  return { binDir, logPath };
}

function runPreflight(
  args: string[],
  fakePnpm?: ReturnType<typeof makeFakePnpm>,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnv,
      ...(fakePnpm
        ? {
            OPENCLAW_RELEASE_PREFLIGHT_PNPM_LOG: fakePnpm.logPath,
            PATH: `${fakePnpm.binDir}${delimiter}${process.env.PATH ?? ""}`,
          }
        : {}),
    },
  });
}

function readPnpmLog(logPath: string): string[] {
  return readFileSync(logPath, "utf8").trimEnd().split("\n").filter(Boolean);
}

describe("scripts/release-preflight.mjs", () => {
  it("rejects unknown arguments before running release checks", () => {
    const result = runPreflight(["--fiix"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown release preflight argument: --fiix");
    expect(result.stderr).toContain("Usage: node scripts/release-preflight.mjs [--check|--fix]");
    expect(result.stdout).toBe("");
  });

  it("runs every check command and reports all failed release artifact checks", () => {
    const fakePnpm = makeFakePnpm();
    const result = runPreflight(["--check"], fakePnpm, {
      OPENCLAW_RELEASE_PREFLIGHT_FAIL_COMMANDS: "plugins:sync:check;config:docs:check",
    });

    expect(result.status).toBe(1);
    expect(readPnpmLog(fakePnpm.logPath)).toEqual(CHECK_COMMANDS);
    expect(result.stderr).toContain("- plugin versions: exit 7 (pnpm plugins:sync:check)");
    expect(result.stderr).toContain("- config docs baseline: exit 7 (pnpm config:docs:check)");
  });

  it("stops refresh mode at the first failed generator before running checks", () => {
    const fakePnpm = makeFakePnpm();
    const result = spawnSync(process.execPath, [SCRIPT, "--fix"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_RELEASE_PREFLIGHT_FAIL_COMMANDS: "deps:shrinkwrap:changed:generate",
        OPENCLAW_RELEASE_PREFLIGHT_PNPM_LOG: fakePnpm.logPath,
        PATH: `${fakePnpm.binDir}${delimiter}${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(1);
    expect(readPnpmLog(fakePnpm.logPath)).toEqual(FIX_COMMANDS.slice(0, 2));
    expect(result.stderr).toContain(
      "- npm shrinkwraps: exit 7 (pnpm deps:shrinkwrap:changed:generate)",
    );
  });
});
