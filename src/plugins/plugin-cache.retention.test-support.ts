import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import {
  checkPluginCacheEntry,
  parsePluginCacheJson,
  readPluginCacheDirectory,
  readPluginCacheFile,
  readPluginCacheJsonFile,
} from "./plugin-cache-files.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";

function readFailure(rootDir: string, scenario: string): Error {
  let error: unknown;
  const params = { rootDir, relativePath: "file.json", rejectHardlinks: false };
  switch (scenario) {
    case "formatter":
    case "formatter-call-sites":
    case "directory":
      try {
        readPluginCacheDirectory(path.join(rootDir, "missing"));
      } catch (failure) {
        error = failure;
      }
      break;
    case "entry-boundary":
    case "entry-hardlink": {
      const result = checkPluginCacheEntry({
        ...params,
        relativePath: scenario === "entry-boundary" ? "../outside.json" : "hardlink.json",
        rejectHardlinks: true,
      });
      assert.equal(result.ok, false);
      if (!result.ok) {
        error = result.error;
      }
      break;
    }
    case "file-missing":
    case "file-hardlink":
    case "file-read":
    case "file-overflow": {
      const result = readPluginCacheFile({
        ...params,
        relativePath: scenario === "file-missing" ? "missing.json" : "hardlink.json",
        rejectHardlinks: scenario === "file-hardlink",
        maxBytes: scenario === "file-overflow" ? 2 : undefined,
      });
      assert.equal(result.ok, false);
      if (!result.ok) {
        error = result.failure.error;
      }
      break;
    }
    case "regular-missing":
    case "regular-overflow": {
      const result = readPluginCacheJsonFile(
        path.join(rootDir, scenario === "regular-missing" ? "missing.json" : "file.json"),
        { maxBytes: scenario === "regular-overflow" ? 2 : undefined },
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        error = result.error;
      }
      break;
    }
    case "json":
    case "json5": {
      const file = readPluginCacheFile(params);
      assert.equal(file.ok, true);
      if (!file.ok) {
        throw new Error("Expected invalid JSON bytes to be readable");
      }
      const result = parsePluginCacheJson(file, { json5: scenario === "json5" });
      assert.equal(result.ok, false);
      if (!result.ok) {
        error = result.error;
      }
      break;
    }
    default:
      throw new Error(`Unknown metadata failure scenario: ${scenario}`);
  }
  assert.ok(error instanceof Error, "The cached failure must preserve its Error object");
  return error;
}

function captureCaller(rootDir: string, scenario: string) {
  const cache = createPluginCache();
  const marker = { label: "metadata caller state" };
  const reference = new WeakRef(marker);
  const originalRead = fs.readSync;
  if (scenario === "file-read") {
    fs.readSync = () => {
      assert.equal(marker.label, "metadata caller state");
      throw Object.assign(new Error("Metadata descriptor read failed"), { code: "EIO" });
    };
  } else if (scenario.endsWith("overflow")) {
    let grew = false;
    fs.readSync = new Proxy(originalRead, {
      apply(target, thisArg, args) {
        if (!grew) {
          grew = true;
          // Grow after the checked open, exercising the real bounded-read cause chain.
          fs.appendFileSync(path.join(rootDir, "file.json"), "more bytes");
        }
        return Reflect.apply(target, thisArg, args);
      },
    });
  }
  try {
    const error = withPluginCache(cache, () => {
      assert.equal(marker.label, "metadata caller state");
      return readFailure(rootDir, scenario);
    });
    return { cache, reference, error };
  } finally {
    fs.readSync = originalRead;
  }
}

const scenario = process.argv[2] ?? "";
const rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plugin-cache-retention-")));
try {
  fs.writeFileSync(path.join(rootDir, "file.json"), "!");
  fs.linkSync(path.join(rootDir, "file.json"), path.join(rootDir, "hardlink.json"));
  const formatter = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
  if (scenario === "formatter") {
    Error.prepareStackTrace = () => {
      throw new Error("Custom stack formatter failed");
    };
  } else if (scenario === "formatter-call-sites") {
    Error.prepareStackTrace = (_error, frames) => frames;
  }
  let captured: ReturnType<typeof captureCaller>;
  try {
    captured = captureCaller(rootDir, scenario);
  } finally {
    if (formatter) {
      Object.defineProperty(Error, "prepareStackTrace", formatter);
    } else {
      Reflect.deleteProperty(Error, "prepareStackTrace");
    }
  }
  const { cache, reference, error } = captured;
  if (scenario.startsWith("formatter")) {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
  }
  const gc = globalThis.gc;
  assert.ok(gc, "The retention child requires --expose-gc");
  const control = new WeakRef({ unowned: true });
  for (let pass = 0; pass < 8; pass += 1) {
    await setImmediate();
    gc();
  }
  assert.equal(control.deref(), undefined, "Unowned control must collect");
  assert.equal(reference.deref(), undefined, `${scenario}: cached error retained caller state`);
  assert.equal(
    withPluginCache(cache, () => readFailure(rootDir, scenario)),
    error,
  );
  assert.equal(typeof error.stack, "string");
  if (scenario.endsWith("overflow")) {
    assert.ok(error.cause instanceof Error, "Bounded read preserves its original cause");
  }
} finally {
  fs.rmSync(rootDir, { recursive: true, force: true });
}
