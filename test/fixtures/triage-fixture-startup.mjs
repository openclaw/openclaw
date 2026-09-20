import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const mode = new URL(import.meta.url).searchParams.get("mode");
const spawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  if (args?.length !== 1 || !args[0].endsWith("/triage-mock-openai.mjs")) {
    return spawn.call(this, command, args, options);
  }
  const startup =
    mode === "exited"
      ? "process.exit(42)"
      : "setInterval(() => {}, 1000); await new Promise(() => {})";
  const child = spawn.call(
    this,
    command,
    ["--import", `data:text/javascript,${encodeURIComponent(startup)}`, ...args],
    options,
  );
  const cleanup = () => {
    child.kill("SIGKILL");
    process.exit(143);
  };
  // A broken acquisition must not leak our deliberately held child after the outer timeout.
  process.once("SIGTERM", cleanup);
  child.once("exit", (code, signal) => {
    process.removeListener("SIGTERM", cleanup);
    process.stderr.write(`triage-fixture-exited:${code ?? signal}\n`);
  });
  return child;
};
syncBuiltinESMExports();
