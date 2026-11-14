import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import { resolvePackageSwapFixture } from "./package-update-swap.test-support.js";

const [root] = process.argv.slice(2);
assert(root, "Crash fixture requires the prepared fixture root");
const fixture = resolvePackageSwapFixture(root);
// Die at the first instant the package path is empty: the link has left it and
// the staged package has not arrived.
const rename = fsp.rename.bind(fsp);
fsp.rename = async (from, to) => {
  await rename(from, to);
  if (String(from) === fixture.packageRoot) {
    fs.writeSync(1, `${JSON.stringify({ backupRoot: String(to) })}\n`);
    process.kill(process.pid, "SIGKILL");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
};
await swapStagedPackageInstall(fixture.params);
throw new Error("Linked package swap finished without reaching the crash cut");
