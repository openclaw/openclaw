#!/usr/bin/env node
import process from "node:process";

import { applyCliProfileEnv, parseCliProfileArgs } from "./cli/profile.js";

if (process.argv.includes("--no-color")) {
  process.env.NO_COLOR = "1";
  process.env.FORCE_COLOR = "0";
}

const parsed = parseCliProfileArgs(process.argv);
if (!parsed.ok) {
  // Keep it simple; Commander will handle rich help/errors after we strip flags.
  console.error(`[clawdbot] ${parsed.error}`);
  process.exit(2);
}

if (parsed.profile) {
  applyCliProfileEnv({ profile: parsed.profile });
  // Keep Commander and ad-hoc argv checks consistent.
  process.argv = parsed.argv;
}

import("./cli/run-main.js")
  .then(({ runCli }) => runCli(process.argv))
  .catch((error) => {
    console.error(
      "[clawdbot] Failed to start CLI:",
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exitCode = 1;
  });
