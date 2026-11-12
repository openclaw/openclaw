import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";

// Inject only the external descriptor read in the real probe child. Classification,
// retry, diagnostic transport, and archive refusal all stay on the production path.
export async function injectHeaderReadFailure(
  directory: string,
  pathname: string,
  code: string,
  failures: number,
  platform = "win32",
) {
  const preload = path.join(directory, "read-failure.cjs");
  const trace = path.join(directory, "read-trace.json");
  await fs.writeFile(
    preload,
    `const fs = require("node:fs");
const target = ${JSON.stringify(pathname)};
const descriptors = new Set();
const open = fs.openSync;
const close = fs.closeSync;
const read = fs.readSync;
const wait = Atomics.wait;
let reads = 0;
const delays = [];
fs.openSync = function(file, ...args) {
  const fd = open.call(this, file, ...args);
  if (String(file) === target) descriptors.add(fd);
  return fd;
};
fs.closeSync = function(fd) {
  descriptors.delete(fd);
  return close.call(this, fd);
};
fs.readSync = function(fd, ...args) {
  if (descriptors.has(fd)) {
    Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
    reads++;
    if (reads <= ${failures}) {
      throw Object.assign(new Error("descriptor read failed"), { code: ${JSON.stringify(code)}, errno: -4082 });
    }
  }
  return read.call(this, fd, ...args);
};
Atomics.wait = function(array, index, value, delay) {
  if (!reads) return wait(array, index, value, delay);
  delays.push(delay);
  return "timed-out";
};
process.on("exit", () => {
  if (reads) fs.writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ reads, delays }));
});
`,
  );
  vi.stubEnv(
    "NODE_OPTIONS",
    `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`,
  );
  return async () => JSON.parse(await fs.readFile(trace, "utf8"));
}
