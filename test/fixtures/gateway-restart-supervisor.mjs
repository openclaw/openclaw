// Emulate only the native stop-timeout read; never contact a real service manager.
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";

const invocationId = process.env.INVOCATION_ID;
const timeoutMs = Number(process.env.OPENCLAW_TEST_SUPERVISOR_STOP_MS);
if (!/^[a-f0-9]{32}$/.test(invocationId ?? "") || timeoutMs !== 46_000) {
  throw new Error("Restart supervisor fixture requires its explicit identity and stop budget");
}
const childProcess = createRequire(import.meta.url)("node:child_process");
const spawn = childProcess.spawn;
childProcess.spawn = function (file, args, options) {
  if (typeof file !== "string" || path.basename(file) !== "systemctl") {
    return Reflect.apply(spawn, this, arguments);
  }
  const request = [...args];
  if (request[0] === "--user" || request[0] === "--system") request.shift();
  if (
    request.length !== 5 ||
    request[0] !== "show" ||
    !request[1]?.endsWith(".service") ||
    request[2] !== "--no-page" ||
    request[3] !== "--property" ||
    request[4] !== "TimeoutStopUSec,InvocationID,LoadState"
  ) {
    throw new Error("Restart supervisor fixture refuses non-read systemctl operations");
  }
  const result = `TimeoutStopUSec=${timeoutMs * 1000}us\nInvocationID=${invocationId}\nLoadState=loaded\n`;
  return Reflect.apply(spawn, this, [
    process.execPath,
    ["-e", `process.stdout.write(${JSON.stringify(result)})`],
    options,
  ]);
};
syncBuiltinESMExports();
