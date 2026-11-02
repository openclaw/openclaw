import path from "node:path";
import { spawn } from "@lydell/node-pty";

const [runtime, home, ...fixtureArgs] = process.argv.slice(2);
if (!runtime || !home || fixtureArgs.length === 0) {
  throw new Error("Usage: clack-prompter.process-driver.mjs <runtime> <home> <fixture args...>");
}

const child = spawn(runtime, fixtureArgs, {
  cwd: process.cwd(),
  cols: 100,
  rows: 30,
  name: "xterm-256color",
  env: {
    ...process.env,
    HOME: home,
    NODE_DISABLE_COMPILE_CACHE: "1",
    NODE_ENV: undefined,
    NODE_OPTIONS: undefined,
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
    NO_COLOR: "1",
    TERM: "xterm-256color",
    VITEST: undefined,
  },
});
let output = "";
let sentEof = false;
const exit = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    child.kill();
    reject(new Error(`onboarding did not exit after Ctrl-D:\n${output}`));
  }, 60_000);
  child.onData((data) => {
    output += data;
    if (!sentEof && output.includes("Continue?")) {
      sentEof = true;
      child.write("\x04");
    }
  });
  child.onExit((event) => {
    clearTimeout(timeout);
    resolve(event);
  });
});

process.stdout.write(`${JSON.stringify({ exit, output, sentEof })}\n`);
