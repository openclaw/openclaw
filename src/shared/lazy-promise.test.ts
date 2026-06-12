// Lazy promise tests cover single-flight loading, error reuse, and dist-rotation detection.
import { describe, expect, it, vi } from "vitest";
import {
  createLazyImportLoader,
  createLazyPromiseLoader,
  isDistRotationError,
} from "./lazy-promise.js";

describe("createLazyPromiseLoader", () => {
  it("dedupes concurrent loads and reuses the resolved value", async () => {
    let calls = 0;
    const loader = createLazyPromiseLoader(async () => `loaded-${++calls}`);

    await expect(Promise.all([loader.load(), loader.load()])).resolves.toEqual([
      "loaded-1",
      "loaded-1",
    ]);
    await expect(loader.load()).resolves.toBe("loaded-1");
    expect(calls).toBe(1);
  });

  it("evicts rejected loads by default so retries can recover", async () => {
    let calls = 0;
    const loader = createLazyPromiseLoader(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("transient");
      }
      return "recovered";
    });

    await expect(loader.load()).rejects.toThrow("transient");
    await expect(loader.load()).resolves.toBe("recovered");
    expect(calls).toBe(2);
  });

  it("can keep rejected loads when requested", async () => {
    const load = vi.fn(async () => {
      throw new Error("sticky");
    });
    const loader = createLazyPromiseLoader(load, { cacheRejections: true });

    await expect(loader.load()).rejects.toThrow("sticky");
    await expect(loader.load()).rejects.toThrow("sticky");
    expect(load).toHaveBeenCalledOnce();
  });

  it("clears cached values", async () => {
    let calls = 0;
    const loader = createLazyPromiseLoader(() => `loaded-${++calls}`);

    await expect(loader.load()).resolves.toBe("loaded-1");
    loader.clear();
    await expect(loader.load()).resolves.toBe("loaded-2");
  });
});

describe("createLazyImportLoader", () => {
  it("wraps import-shaped loaders", async () => {
    const loader = createLazyImportLoader(async () => ({ value: "module" }));

    await expect(loader.load()).resolves.toEqual({ value: "module" });
  });
});

describe("isDistRotationError", () => {
  it("detects ERR_MODULE_NOT_FOUND inside the openclaw dist tree", () => {
    const err = Object.assign(
      new Error(
        "Cannot find module '/usr/lib/node_modules/openclaw/dist/cleanup-DlVQZQex.js'" +
          " imported from /usr/lib/node_modules/openclaw/dist/chunks/get-reply.js",
      ),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    expect(isDistRotationError(err)).toBe(true);
  });

  it("detects MODULE_NOT_FOUND inside the openclaw dist tree (Windows path)", () => {
    const err = Object.assign(
      new Error(
        "Cannot find module 'C:\\Users\\app\\openclaw\\dist\\chunk-abc123.js'" +
          " imported from C:\\Users\\app\\openclaw\\dist\\chunks\\index.js",
      ),
      { code: "MODULE_NOT_FOUND" },
    );
    expect(isDistRotationError(err)).toBe(true);
  });

  it("returns false when a third-party package is missing but importer is under openclaw/dist/", () => {
    // Regression: the missing target is a third-party dependency, not a
    // dist chunk.  The importer path contains openclaw/dist/ but that
    // alone does not make this a rotation error.
    const err = Object.assign(
      new Error(
        "Cannot find package 'optional-dep'" +
          " imported from /usr/lib/node_modules/openclaw/dist/chunks/get-reply.js",
      ),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    expect(isDistRotationError(err)).toBe(false);
  });

  it("returns false for ERR_MODULE_NOT_FOUND outside the dist tree", () => {
    const err = Object.assign(
      new Error("Cannot find module '/usr/lib/node_modules/other-pkg/index.js'"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    expect(isDistRotationError(err)).toBe(false);
  });

  it("returns false for unrelated error codes", () => {
    const err = Object.assign(new Error("Something broke"), { code: "ENOENT" });
    expect(isDistRotationError(err)).toBe(false);
  });

  it("returns false for error objects without a code", () => {
    expect(isDistRotationError(new Error("plain error"))).toBe(false);
  });

  it("returns false for null and non-objects", () => {
    expect(isDistRotationError(null)).toBe(false);
    expect(isDistRotationError(undefined)).toBe(false);
    expect(isDistRotationError("string")).toBe(false);
    expect(isDistRotationError(42)).toBe(false);
  });
});
