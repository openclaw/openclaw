import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.OPENCLAW_TEST_NATIVE_RUNNER_ROOT;
const sourceRoot = process.env.OPENCLAW_TEST_NATIVE_RUNNER_SOURCE;
const mode = process.env.OPENCLAW_TEST_NATIVE_RUNNER_MODE;
if (!root || !sourceRoot || (mode !== "runner" && mode !== "watch")) {
  throw new Error("Native runner signal fixture is missing its private scope");
}
const fixture = fileURLToPath(import.meta.url);
const release = path.join(root, "release");
const terminate = path.join(root, "terminate");
const released = () => fs.existsSync(release);
const writePid = (role) => {
  const destination = path.join(root, `${role}.pid`);
  fs.writeFileSync(destination + ".tmp", String(process.pid));
  fs.renameSync(destination + ".tmp", destination);
};
const waitForRelease = (mayTerminate) => {
  setInterval(() => {
    if (released()) {
      process.exit(0);
    }
    if (mayTerminate && fs.existsSync(terminate)) {
      process.kill(process.pid, "SIGKILL");
    }
  }, 20);
};

if (process.argv.includes("--fixture-worker")) {
  writePid("worker");
  waitForRelease(false);
} else if (process.argv.includes("--fixture-build")) {
  if (released()) {
    process.exit(0);
  }
  writePid("build");
  const worker = childProcess.spawn(process.execPath, [fixture, "--fixture-worker"], {
    detached: true,
    env: process.env,
    // This writer is behind run-node's private build-output pipe, not the
    // native entrypoint's inherited stdout/stderr or its process group.
    stdio: ["ignore", "ignore", "inherit"],
  });
  worker.unref();
  waitForRelease(mode === "runner");
} else if (process.argv[1] === path.join(sourceRoot, "scripts/run-node.mts")) {
  if (process.argv[2] === "doctor") {
    fs.writeFileSync(path.join(root, "doctor-started"), "ready");
    process.exit(0);
  }
  // An unsafe old watcher can run doctor and restart after losing its first
  // owner. Let that replacement acknowledge zero without spawning more work.
  if (fs.existsSync(path.join(root, "implementation.pid"))) {
    process.exit(0);
  }
  writePid("implementation");
  const spawn = childProcess.spawn;
  childProcess.spawn = (_command, _args, options) =>
    spawn(process.execPath, [fixture, "--fixture-build"], options);
  syncBuiltinESMExports();
  waitForRelease(mode === "watch");
} else if (process.argv[1] === path.join(sourceRoot, "scripts/watch-node.mts")) {
  const spawn = childProcess.spawn;
  childProcess.spawn = (command, args, options) =>
    spawn(command, [path.join(sourceRoot, "scripts/run-node.mjs"), ...args.slice(1)], options);
  syncBuiltinESMExports();
  waitForRelease(false);
}
