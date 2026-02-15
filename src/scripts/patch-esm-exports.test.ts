import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const esmRequire = createRequire(import.meta.url);
const { patchExports, patchDir } = esmRequire("../../scripts/patch-esm-exports.cjs") as {
  patchExports: (exports: unknown) => boolean;
  patchDir: (dir: string) => {
    patchedCount: number;
    errors: Array<{ file: string; error: string }>;
  };
};

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "esm-patch-test-"));

afterAll(() => {
  try {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
});

let caseIndex = 0;
function makeDir() {
  const dir = path.join(fixtureRoot, `case-${caseIndex++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writePackageJson(dir: string, pkg: unknown) {
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");
}

function readPackageJson(dir: string) {
  return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
}

describe("patchExports", () => {
  it("adds 'default' condition when only 'import' exists", () => {
    const exports = {
      ".": { import: "./dist/index.mjs" },
    };
    const modified = patchExports(exports);
    expect(modified).toBe(true);
    expect(exports["."]).toEqual({
      import: "./dist/index.mjs",
      default: "./dist/index.mjs",
    });
  });

  it("does not modify entries with existing 'default' condition", () => {
    const exports = {
      ".": { import: "./dist/index.mjs", default: "./dist/index.cjs" },
    };
    const modified = patchExports(exports);
    expect(modified).toBe(false);
    expect(exports["."]).toEqual({
      import: "./dist/index.mjs",
      default: "./dist/index.cjs",
    });
  });

  it("does not modify entries with existing 'require' condition", () => {
    const exports = {
      ".": { import: "./dist/index.mjs", require: "./dist/index.cjs" },
    };
    const modified = patchExports(exports);
    expect(modified).toBe(false);
    expect(exports["."]).toEqual({
      import: "./dist/index.mjs",
      require: "./dist/index.cjs",
    });
  });

  it("handles string shorthand exports without modification", () => {
    const exports = { ".": "./dist/index.js" };
    const modified = patchExports(exports);
    expect(modified).toBe(false);
  });

  it("handles non-object export values without modification", () => {
    const exports = { ".": null, "./foo": 42 };
    const modified = patchExports(exports);
    expect(modified).toBe(false);
  });

  it("handles array export values without modification", () => {
    const exports = { ".": ["./dist/a.js", "./dist/b.js"] };
    const modified = patchExports(exports);
    expect(modified).toBe(false);
  });

  it("returns false for null", () => {
    expect(patchExports(null)).toBe(false);
  });

  it("returns false for a string", () => {
    expect(patchExports("./index.js")).toBe(false);
  });

  it("returns false for an array", () => {
    expect(patchExports(["./index.js"])).toBe(false);
  });

  it("handles multiple export entries", () => {
    const exports = {
      ".": { import: "./dist/index.mjs" },
      "./hooks": { import: "./dist/hooks.mjs" },
      "./*": { import: "./dist/*.mjs", require: "./dist/*.cjs" },
    };
    const modified = patchExports(exports);
    expect(modified).toBe(true);
    expect(exports["."]).toHaveProperty("default", "./dist/index.mjs");
    expect(exports["./hooks"]).toHaveProperty("default", "./dist/hooks.mjs");
    expect(exports["./*"]).not.toHaveProperty("default");
  });

  it("preserves existing fields in the exports entry", () => {
    const exports = {
      ".": { import: "./dist/index.mjs", types: "./dist/index.d.ts" },
    };
    patchExports(exports);
    expect(exports["."]).toEqual({
      import: "./dist/index.mjs",
      types: "./dist/index.d.ts",
      default: "./dist/index.mjs",
    });
  });
});

describe("patchDir", () => {
  it("patches package.json that needs 'default' condition", () => {
    const root = makeDir();
    const pkgDir = path.join(root, "node_modules", "esm-only-pkg");
    fs.mkdirSync(pkgDir, { recursive: true });
    writePackageJson(pkgDir, {
      name: "esm-only-pkg",
      exports: { ".": { import: "./dist/index.mjs" } },
    });

    const result = patchDir(root);

    expect(result.patchedCount).toBe(1);
    expect(result.errors).toHaveLength(0);
    const pkg = readPackageJson(pkgDir);
    expect(pkg.exports["."]).toHaveProperty("default", "./dist/index.mjs");
  });

  it("does not modify packages with existing 'default' condition", () => {
    const root = makeDir();
    const pkgDir = path.join(root, "node_modules", "dual-pkg");
    fs.mkdirSync(pkgDir, { recursive: true });
    writePackageJson(pkgDir, {
      name: "dual-pkg",
      exports: { ".": { import: "./dist/index.mjs", default: "./dist/index.cjs" } },
    });

    const result = patchDir(root);

    expect(result.patchedCount).toBe(0);
    const pkg = readPackageJson(pkgDir);
    expect(pkg.exports["."]).toEqual({
      import: "./dist/index.mjs",
      default: "./dist/index.cjs",
    });
  });

  it("handles packages with no exports field", () => {
    const root = makeDir();
    const pkgDir = path.join(root, "node_modules", "no-exports-pkg");
    fs.mkdirSync(pkgDir, { recursive: true });
    writePackageJson(pkgDir, { name: "no-exports-pkg", main: "./index.js" });

    const result = patchDir(root);

    expect(result.patchedCount).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("handles malformed package.json gracefully", () => {
    const root = makeDir();
    const pkgDir = path.join(root, "node_modules", "bad-pkg");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), "{ not valid json !!!", "utf8");

    const result = patchDir(root);

    expect(result.patchedCount).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].file).toContain("bad-pkg");
  });

  it("is idempotent - running twice produces same result", () => {
    const root = makeDir();
    const pkgDir = path.join(root, "node_modules", "idem-pkg");
    fs.mkdirSync(pkgDir, { recursive: true });
    writePackageJson(pkgDir, {
      name: "idem-pkg",
      exports: { ".": { import: "./dist/index.mjs" } },
    });

    patchDir(root);
    const afterFirst = readPackageJson(pkgDir);

    const secondResult = patchDir(root);
    const afterSecond = readPackageJson(pkgDir);

    expect(secondResult.patchedCount).toBe(0);
    expect(afterSecond).toEqual(afterFirst);
  });

  it("respects max depth limit", () => {
    const root = makeDir();
    // Create a deeply nested directory (depth > 8)
    let nested = root;
    for (let i = 0; i < 10; i++) {
      nested = path.join(nested, `level-${i}`);
    }
    fs.mkdirSync(nested, { recursive: true });
    writePackageJson(nested, {
      name: "deep-pkg",
      exports: { ".": { import: "./dist/index.mjs" } },
    });

    const result = patchDir(root);

    expect(result.patchedCount).toBe(0);
  });

  it("skips .cache and .store directories", () => {
    const root = makeDir();

    for (const skipDir of [".cache", ".store"]) {
      const pkgDir = path.join(root, skipDir, "hidden-pkg");
      fs.mkdirSync(pkgDir, { recursive: true });
      writePackageJson(pkgDir, {
        name: `hidden-${skipDir}`,
        exports: { ".": { import: "./dist/index.mjs" } },
      });
    }

    const result = patchDir(root);

    expect(result.patchedCount).toBe(0);
  });

  it("handles multiple packages in the same tree", () => {
    const root = makeDir();
    const nm = path.join(root, "node_modules");

    const pkgA = path.join(nm, "pkg-a");
    fs.mkdirSync(pkgA, { recursive: true });
    writePackageJson(pkgA, {
      name: "pkg-a",
      exports: { ".": { import: "./a.mjs" } },
    });

    const pkgB = path.join(nm, "pkg-b");
    fs.mkdirSync(pkgB, { recursive: true });
    writePackageJson(pkgB, {
      name: "pkg-b",
      exports: { ".": { import: "./b.mjs", default: "./b.cjs" } },
    });

    const pkgC = path.join(nm, "pkg-c");
    fs.mkdirSync(pkgC, { recursive: true });
    writePackageJson(pkgC, {
      name: "pkg-c",
      exports: { ".": { import: "./c.mjs" }, "./sub": { import: "./sub.mjs" } },
    });

    const result = patchDir(root);

    expect(result.patchedCount).toBe(2);
    expect(readPackageJson(pkgA).exports["."]).toHaveProperty("default", "./a.mjs");
    expect(readPackageJson(pkgB).exports["."].default).toBe("./b.cjs");
    expect(readPackageJson(pkgC).exports["."]).toHaveProperty("default", "./c.mjs");
    expect(readPackageJson(pkgC).exports["./sub"]).toHaveProperty("default", "./sub.mjs");
  });
});

describe("affected packages verification", () => {
  it("correctly identifies @buape/carbon as needing patch", () => {
    const root = makeDir();
    const pkgDir = path.join(root, "node_modules", "@buape", "carbon");
    fs.mkdirSync(pkgDir, { recursive: true });
    writePackageJson(pkgDir, {
      name: "@buape/carbon",
      exports: {
        ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
        "./*": { import: "./dist/*.js", types: "./dist/*.d.ts" },
      },
    });

    const result = patchDir(root);

    expect(result.patchedCount).toBe(1);
    const pkg = readPackageJson(pkgDir);
    expect(pkg.exports["."]).toHaveProperty("default", "./dist/index.js");
    expect(pkg.exports["./*"]).toHaveProperty("default", "./dist/*.js");
    expect(pkg.exports["."].types).toBe("./dist/index.d.ts");
  });

  it("correctly identifies osc-progress as needing patch", () => {
    const root = makeDir();
    const pkgDir = path.join(root, "node_modules", "osc-progress");
    fs.mkdirSync(pkgDir, { recursive: true });
    writePackageJson(pkgDir, {
      name: "osc-progress",
      exports: {
        ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
      },
    });

    const result = patchDir(root);

    expect(result.patchedCount).toBe(1);
    const pkg = readPackageJson(pkgDir);
    expect(pkg.exports["."]).toHaveProperty("default", "./dist/index.js");
  });

  it("correctly identifies @mariozechner/pi-coding-agent as needing patch", () => {
    const root = makeDir();
    const pkgDir = path.join(root, "node_modules", "@mariozechner", "pi-coding-agent");
    fs.mkdirSync(pkgDir, { recursive: true });
    writePackageJson(pkgDir, {
      name: "@mariozechner/pi-coding-agent",
      exports: {
        ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
      },
    });

    const result = patchDir(root);

    expect(result.patchedCount).toBe(1);
    const pkg = readPackageJson(pkgDir);
    expect(pkg.exports["."]).toHaveProperty("default", "./dist/index.js");
  });
});
