import fs from "node:fs/promises";
import path from "node:path";
import { splitShellArgs } from "../utils/shell-argv.js";
import { resolveExecutableFromPathEnv } from "./executable-path.js";
import { hasNodeErrorCode } from "./path-guards.js";
import { resolveEnvironmentValue } from "./process-env.js";

/** Match the installer shape; relocation also pins the executable that launched this CLI. */
export async function matchesStandaloneGitWrapper(
  contents: string,
  previousRoot: string,
  platform: NodeJS.Platform,
  expectedNodeRunner?: string,
): Promise<boolean> {
  const expectedEntry =
    platform === "win32"
      ? path.win32.join(previousRoot, "dist", "entry.js")
      : path.join(previousRoot, "dist", "entry.js");
  const lines = contents.trimEnd().split(/\r?\n/u);
  const matchesWindows =
    platform === "win32" &&
    lines.length === 2 &&
    lines[0] === "@echo off" &&
    lines[1] === `node "${expectedEntry}" %*`;
  const execArgs =
    platform === "win32" || lines.length !== 3 ? null : splitShellArgs(lines[2] ?? "");
  const matchesPosix =
    platform !== "win32" &&
    lines[0] === "#!/usr/bin/env bash" &&
    lines[1] === "set -euo pipefail" &&
    execArgs?.length === 4 &&
    execArgs[0] === "exec" &&
    execArgs[2] === expectedEntry &&
    execArgs[3] === "$@";

  if (!matchesWindows && !matchesPosix) {
    return false;
  }
  return expectedNodeRunner
    ? matchesNodeRunner(
        matchesWindows ? resolveWindowsNodeRunner() : execArgs?.[1],
        expectedNodeRunner,
      )
    : true;
}

function resolveWindowsNodeRunner(): string | undefined {
  const pathEnv = resolveEnvironmentValue(process.env, "PATH") ?? "";
  // cmd.exe searches the current directory first unless Windows disables that lookup.
  const windowsSearchPath =
    resolveEnvironmentValue(process.env, "NoDefaultCurrentDirectoryInExePath") !== undefined
      ? pathEnv
      : `${process.cwd()};${pathEnv}`;
  return resolveExecutableFromPathEnv("node", windowsSearchPath, process.env, {
    includeExtensionless: false,
    useCache: false,
  });
}

async function matchesNodeRunner(
  executable: string | undefined,
  expectedNodeRunner: string,
): Promise<boolean> {
  if (!executable || !path.isAbsolute(executable)) {
    return false;
  }
  const [actual, expected] = await Promise.all([
    fs.realpath(executable).catch(() => null),
    fs.realpath(expectedNodeRunner).catch(() => null),
  ]);
  return actual !== null && actual === expected;
}

// npm/cmd-shim's Node-bin contract. Checking only its target would authorize custom batch setup.
const NPM_GIT_CMD_SHIM = String.raw`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\openclaw\openclaw.mjs" %*`;

export async function matchesNpmGitCmdShim(
  contents: string,
  launcher: string,
  root: string,
  expectedNodeRunner: string,
): Promise<boolean> {
  if (
    process.platform !== "win32" ||
    contents.replaceAll("\r\n", "\n").trimEnd() !== NPM_GIT_CMD_SHIM
  ) {
    return false;
  }
  const prefix = path.dirname(launcher);
  const entry = await fs
    .realpath(path.join(prefix, "node_modules", "openclaw", "openclaw.mjs"))
    .catch(() => null);
  if (entry !== path.join(root, "openclaw.mjs")) {
    return false;
  }
  const siblingNode = path.join(prefix, "node.exe");
  const sibling = await fs.stat(siblingNode).catch((error: unknown) => {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  // npm prefers its sibling node.exe before looking through PATH.
  return sibling
    ? sibling.isFile() && matchesNodeRunner(siblingNode, expectedNodeRunner)
    : matchesNodeRunner(resolveWindowsNodeRunner(), expectedNodeRunner);
}
