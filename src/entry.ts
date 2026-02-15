#!/usr/bin/env node
import process from "node:process";
import { applyCliProfileEnv, parseCliProfileArgs } from "./cli/profile.js";
import { normalizeWindowsArgv } from "./cli/windows-argv.js";
import { normalizeEnv } from "./infra/env.js";
import { installProcessWarningFilter } from "./infra/warning-filter.js";

process.title = "openclaw";
installProcessWarningFilter();
normalizeEnv();

if (process.argv.includes("--no-color")) {
  process.env.NO_COLOR = "1";
  process.env.FORCE_COLOR = "0";
}

process.argv = normalizeWindowsArgv(process.argv);

const parsed = parseCliProfileArgs(process.argv);
if (!parsed.ok) {
  console.error(`[openclaw] ${parsed.error}`);
  process.exit(2);
}

if (parsed.profile) {
  applyCliProfileEnv({ profile: parsed.profile });
  process.argv = parsed.argv;
}

import("./cli/run-main.js")
  .then(({ runCli }) => runCli(process.argv))
  .catch((error) => {
    console.error(
      "[openclaw] Failed to start CLI:",
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exitCode = 1;
  });
