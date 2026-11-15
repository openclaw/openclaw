#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";

const args = process.argv.slice(2);
if (path.basename(process.argv[1]) === "sudo") {
  if (args[0] !== "-n") {
    process.exit(2);
  }
  if (args[1] === "/bin/kill") {
    process.kill(Number(args.at(-1)), args[2].replace("-", "SIG"));
  } else {
    const child = spawn(args[1], args.slice(2), { stdio: "inherit" });
    process.on("SIGTERM", () => {});
    child.once("exit", (code) => process.exit(code ?? 1));
  }
} else {
  const socket = connect(process.env.OPENCLAW_TEST_TAILSCALE_FIXTURE_SOCKET);
  process.once("SIGTERM", () => {
    writeFileSync(process.env.OPENCLAW_TEST_TAILSCALE_FIXTURE_MARKER, "stopped");
    socket.end(() => process.exit(0));
  });
  socket.once("connect", () => socket.write(String(process.pid)));
}
