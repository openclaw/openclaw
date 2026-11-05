#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const sudo = args[0] === "-n";
const commandArgs = sudo ? args.slice(2) : args;
const commandLog = process.env.OPENCLAW_TEST_TAILSCALE_FIXTURE_COMMAND_LOG;
if (commandLog) {
  appendFileSync(commandLog, `${JSON.stringify({ args })}\n`);
}

if (commandArgs.includes("status")) {
  if (process.env.OPENCLAW_TEST_TAILSCALE_SUDO_FIXTURE_MODE === "authentication") {
    if (sudo) {
      const marker = process.env.OPENCLAW_TEST_TAILSCALE_FIXTURE_MARKER;
      const commandCount = commandLog
        ? readFileSync(commandLog, "utf8").trim().split("\n").length
        : 0;
      if (marker && commandCount >= 4) {
        writeFileSync(marker, "recovery-poll");
      }
      process.stdout.write(JSON.stringify({ BackendState: "NeedsLogin" }));
    } else {
      process.stderr.write("Access denied: status requires operator authorization\n");
    }
    process.exit(1);
  }
  process.stdout.write("{}");
  process.exit(0);
}
if (sudo) {
  const mode = process.env.OPENCLAW_TEST_TAILSCALE_SUDO_FIXTURE_MODE;
  if (mode === "password") {
    process.stderr.write("sudo: a password is required\n");
  } else if (mode === "route-error") {
    process.stderr.write("Funnel is not enabled on your tailnet.\n");
  } else {
    process.stderr.write("listener already exists for port 443\n");
  }
} else {
  process.stderr.write("Access denied: serve config denied\nUse 'sudo tailscale serve'.\n");
}
process.exit(1);
