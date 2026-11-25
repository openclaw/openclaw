import assert from "node:assert/strict";
// Adapted from fs-safe's DrvFS preparation probe: compare complete filesystem call maps.
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
// Resolve the selected dependency, including its matching native binding.
const load = (name) =>
  import(new URL(`${name}.js`, import.meta.resolve("@openclaw/fs-safe/atomic")));
const { getNativeBinding } = await load("native");
const native = getNativeBinding();
assert.equal(typeof native?.is9pFilesystem, "function", "built native probe is required");
const actualPlatform = process.platform;
const directory = fs.mkdtempSync(path.join(process.argv[2] ?? ".", "drvfs-calls-"));
const physical = {
  platform: actualPlatform,
  dev: String(fs.statSync(directory, { bigint: true }).dev),
  magic: `0x${fs.statfsSync(directory, { bigint: true }).type.toString(16)}`,
};
const { replaceFileAtomic, replaceFileAtomicSync } = await load("atomic");
const target = path.join(directory, "target");
let counts;
let renamed = false;
let fault;
const count = (name) => {
  if (counts) {
    counts[name] = (counts[name] ?? 0) + 1;
  }
};
const probe = native.is9pFilesystem;
native.is9pFilesystem = (fd) => {
  count("native.fstatfs");
  return probe(fd);
};
function inject(name, args) {
  if ((name === "lstatSync" || name === "lstat") && renamed && args[0] === target && fault) {
    throw Object.assign(new Error("synthetic post-rename failure"), { code: fault });
  }
}
for (const name of Object.keys(fs).filter(
  (key) => key.endsWith("Sync") && typeof fs[key] === "function",
)) {
  const original = fs[name];
  const wrapped = function (...args) {
    count(`fs.${name}`);
    inject(name, args);
    const result = Reflect.apply(original, fs, args);
    if (name === "renameSync" && args[1] === target) {
      renamed = true;
    }
    return result;
  };
  if (typeof original.native === "function") {
    wrapped.native = function (...args) {
      count(`fs.${name}.native`);
      return Reflect.apply(original.native, fs, args);
    };
  }
  fs[name] = wrapped;
}
for (const name of Object.keys(fsp).filter((key) => typeof fsp[key] === "function")) {
  const original = fsp[name];
  fsp[name] = async function (...args) {
    count(`fsp.${name}`);
    inject(name, args);
    const result = await Reflect.apply(original, fsp, args);
    if (name === "rename" && args[1] === target) {
      renamed = true;
    }
    if (name === "open") {
      for (const method of [
        "stat",
        "chmod",
        "write",
        "writeFile",
        "read",
        "readFile",
        "sync",
        "datasync",
        "close",
      ]) {
        const originalMethod = result[method];
        result[method] = function (...values) {
          count(`handle.${method}`);
          return Reflect.apply(originalMethod, this, values);
        };
      }
    }
    return result;
  };
}
syncBuiltinESMExports();
const rows = [];
async function measure(sync, enabled, errorCode) {
  counts = undefined;
  fault = undefined;
  renamed = false;
  fs.writeFileSync(target, "old");
  counts = {};
  fault = errorCode;
  let outcome = "success";
  try {
    await (sync ? replaceFileAtomicSync : replaceFileAtomic)({
      filePath: target,
      content: "payload",
      allowDrvfsRenameRecovery: enabled,
    });
  } catch (error) {
    outcome = error.code;
  }
  const captured = counts;
  counts = undefined;
  fault = undefined;
  assert.equal(outcome, errorCode ?? "success");
  return { counts: captured, total: Object.values(captured).reduce((a, b) => a + b, 0) };
}
try {
  // Warm module work without populating the opt-in cache, then measure its cold cost.
  await measure(false, false);
  const coldOff = await measure(false, false);
  const coldOn = await measure(false, true);
  rows.push({
    writer: "async",
    phase: "cold",
    off: coldOff.total,
    on: coldOn.total,
    delta: coldOn.total - coldOff.total,
    probe: coldOn.counts["native.fstatfs"] ?? 0,
  });
  for (const sync of [false, true]) {
    for (const errorCode of [undefined, "EACCES", "EIO"]) {
      for (let repetition = 0; repetition < 2; repetition++) {
        const off = await measure(sync, false, errorCode);
        const on = await measure(sync, true, errorCode);
        assert.deepEqual(on.counts, off.counts);
        rows.push({
          writer: sync ? "sync" : "async",
          phase: "warm",
          outcome: errorCode ?? "success",
          repetition,
          off: off.total,
          on: on.total,
          delta: on.total - off.total,
        });
      }
    }
  }
  console.log(
    JSON.stringify(
      {
        runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`,
        physical,
        rows,
      },
      null,
      2,
    ),
  );
} finally {
  counts = undefined;
  fs.rmSync(directory, { recursive: true, force: true });
}
