import fs from "node:fs";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";

const key = "openclaw.test.workspaceFilesystemBlock";
const { entry, words: buffer, pathname: pathBuffer, method } = getEnvironmentData(key);
setEnvironmentData(key, undefined);
const words = new Int32Array(buffer);
const pathname = new Uint8Array(pathBuffer);
function observe(file) {
  if (
    Atomics.load(words, 0) > 0 &&
    String(file) === Buffer.from(pathname.subarray(0, Atomics.load(words, 3))).toString() &&
    Atomics.sub(words, 0, 1) === 1
  ) {
    Atomics.store(words, 1, 1);
    Atomics.notify(words, 1);
    while (Atomics.load(words, 2) === 0) {
      Atomics.wait(words, 2, 0);
    }
  }
}
if (method === "mutationExists") {
  Error.stackTraceLimit = 50;
  const exists = fs.existsSync;
  fs.existsSync = function (file) {
    if (new Error().stack?.includes("assertBeforeMutation")) {
      observe(file);
    }
    return Reflect.apply(exists, this, [file]);
  };
} else if (method === "lstat") {
  const lstat = fs.promises.lstat;
  fs.promises.lstat = async function (file, ...args) {
    const result = await Reflect.apply(lstat, this, [file, ...args]);
    observe(file);
    return result;
  };
} else {
  const stat = fs.statSync;
  fs.statSync = function (file, ...args) {
    observe(file);
    return Reflect.apply(stat, this, [file, ...args]);
  };
}
await import(entry);
