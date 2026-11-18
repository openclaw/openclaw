import children from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const configPath = new URL(import.meta.url).searchParams.get("config");
if (!configPath) {
  throw new Error("recovery clock requires fixture configuration");
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

// Only the generated fixture helper intercepts its exact recovery command.
// Descendants inherit the preload but keep their native clocks and spawns.
if (process.argv[1] === config.scriptPath) {
  const spawn = children.spawn;
  const setTimeout = globalThis.setTimeout;
  const clearTimeout = globalThis.clearTimeout;
  const commandTail = config.commandArgv.slice(1);
  let recovery;
  let captured = false;
  children.spawn = (command, args, options) => {
    const child = spawn(command, args, options);
    if (
      command === config.commandArgv[0] &&
      (args.at(-1) === JSON.stringify(config.commandArgv) ||
        JSON.stringify(args.slice(-commandTail.length)) === JSON.stringify(commandTail))
    ) {
      recovery = child;
      child.once("close", () => {
        recovery = undefined;
      });
    }
    return child;
  };
  syncBuiltinESMExports();
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (!recovery || delay !== config.timeoutMs) {
      return setTimeout(callback, delay, ...args);
    }
    if (captured) {
      throw new Error("duplicate recovery deadline");
    }
    captured = true;
    const child = recovery;
    const deadline = { requestedMs: delay };
    let buffered = "";
    let expired = false;
    const expire = () => {
      if (expired) {
        return;
      }
      expired = true;
      clearTimeout(timer);
      child.stdout.removeListener("data", onData);
      try {
        fs.writeFileSync(config.deadlinePath, JSON.stringify(deadline));
      } finally {
        callback.apply(timer, args);
      }
    };
    const onData = (chunk) => {
      buffered = (buffered + chunk.toString()).slice(-1024);
      if (!buffered.includes(`${config.readyMarker}\n`)) {
        return;
      }
      try {
        const pid = JSON.parse(fs.readFileSync(config.statePath, "utf8")).recoveryDescendantPid;
        if (!Number.isSafeInteger(pid) || pid <= 0) {
          throw new Error("missing recovery descendant PID");
        }
        process.kill(pid, 0);
        deadline.descendantPid = pid;
      } catch {
        // Still join native cleanup; the readiness assertion reports this fixture failure.
      }
      expire();
    };
    // Missing readiness still expires the native callback and joins its cleanup.
    const timer = setTimeout(expire, 30_000);
    child.stdout.on("data", onData);
    child.once("close", () => {
      clearTimeout(timer);
      child.stdout.removeListener("data", onData);
    });
    return timer;
  };
}
