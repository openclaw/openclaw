#!/usr/bin/env node
import process from "node:process";

import { applyCliProfileEnv, parseCliProfileArgs } from "./cli/profile.js";

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

const { runCli } = await import("./cli/run-main.js");
await runCli(process.argv);
