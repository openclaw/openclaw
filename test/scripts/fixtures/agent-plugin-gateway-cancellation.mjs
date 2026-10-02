import childProcess from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { setImmediate } from "node:timers/promises";

const controls = process.env.AGENT_PLUGIN_E2E_FIXTURE_DIR;
const phase = process.env.AGENT_PLUGIN_E2E_WRITE_PHASE;
const signal = process.env.AGENT_PLUGIN_E2E_SIGNAL;
if (!controls || !["fixture", "config", "install"].includes(phase)) {
  throw new Error("Missing synthetic cancellation fixture inputs");
}
if (signal) {
  // Observe actual OS delivery before the parent releases the awaited write.
  process.once(signal, () => process.stdout.write(`fixture-signal-${signal}\n`));
}

const writeFile = fsPromises.writeFile.bind(fsPromises);
let heldWrite = false;
fsPromises.writeFile = async (file, ...args) => {
  await writeFile(file, ...args);
  const name = String(file);
  const matches =
    phase === "fixture"
      ? path.basename(name) === "server.mjs" &&
        path.basename(path.dirname(name)) === "weather-helper"
      : phase === "config" &&
        path.basename(name) === "openclaw.json" &&
        path.basename(path.dirname(name)) === "state";
  if (!matches || heldWrite) {
    return;
  }
  heldWrite = true;
  fs.writeFileSync(path.join(controls, "fixture-root"), path.dirname(path.dirname(name)));
  const release = path.join(controls, "release");
  process.stdout.write("fixture-write-ready\n");
  while (!fs.existsSync(release)) {
    await setImmediate();
  }
};

const spawn = childProcess.spawn.bind(childProcess);
childProcess.spawn = (command, args, options) => {
  const entry = args?.[0];
  if (
    typeof entry === "string" &&
    entry.endsWith(`${path.sep}scripts${path.sep}run-node.mjs`) &&
    args[1] === "plugins" &&
    args[2] === "install"
  ) {
    fs.appendFileSync(path.join(controls, "launches"), "install\n");
    const child = spawn(
      command,
      [
        "--eval",
        `
        require("node:fs").writeFileSync(process.env.OPENCLAW_CONFIG_PATH, "{}");
        if (process.env.AGENT_PLUGIN_E2E_WRITE_PHASE === "install") {
          process.on("SIGTERM", () => process.exit(0));
          console.log("synthetic-installer-ready");
          setInterval(() => {}, 1000);
        }
      `,
      ],
      options,
    );
    if (phase === "install") {
      fs.writeFileSync(
        path.join(controls, "fixture-root"),
        path.dirname(path.dirname(options.env.OPENCLAW_CONFIG_PATH)),
      );
      let output = "";
      const ready = (chunk) => {
        output += chunk.toString();
        if (output.includes("synthetic-installer-ready\n")) {
          child.stdout.off("data", ready);
          process.stdout.write("fixture-write-ready\n");
        }
      };
      child.stdout.on("data", ready);
    }
    return child;
  }
  if (
    entry === "scripts/e2e/mock-openai-server.mjs" ||
    (typeof entry === "string" && entry.endsWith(`${path.sep}dist${path.sep}index.js`))
  ) {
    const kind = entry === "scripts/e2e/mock-openai-server.mjs" ? "mock" : "gateway";
    fs.appendFileSync(path.join(controls, "launches"), `${kind}\n`);
    throw new Error(`Synthetic service launch stopped at ${kind}`);
  }
  // The maintained tsx preload may start its compiler; no other launch is allowed.
  if (
    path.basename(command) === "esbuild" &&
    args?.length === 2 &&
    args[0].startsWith("--service=") &&
    args[1] === "--ping"
  ) {
    return spawn(command, args, options);
  }
  throw new Error(`Unexpected child command in cancellation fixture: ${command}`);
};
syncBuiltinESMExports();
globalThis.fetch = async () => {
  throw new Error("The cancellation fixture must not make HTTP requests");
};
