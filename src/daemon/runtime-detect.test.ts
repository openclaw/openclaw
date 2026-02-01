import { describe, expect, it } from "vitest";
import { isBunRuntime, isNodeRuntime } from "./runtime-detect.js";

describe("isNodeRuntime", () => {
  it("should recognize standard node binary", () => {
    expect(isNodeRuntime("/usr/bin/node")).toBe(true);
    expect(isNodeRuntime("/usr/local/bin/node")).toBe(true);
    expect(isNodeRuntime("C:\\Program Files\\nodejs\\node.exe")).toBe(true);
  });

  it("should recognize nodejs (Debian/Ubuntu)", () => {
    expect(isNodeRuntime("/usr/bin/nodejs")).toBe(true);
    expect(isNodeRuntime("C:\\nodejs.exe")).toBe(true);
  });

  it("should recognize openSUSE-style versioned binaries", () => {
    expect(isNodeRuntime("/usr/bin/node24")).toBe(true);
    expect(isNodeRuntime("/usr/bin/node22")).toBe(true);
    expect(isNodeRuntime("/usr/bin/node18")).toBe(true);
  });

  it("should recognize hyphen-style versioned binaries", () => {
    expect(isNodeRuntime("/usr/bin/node-22")).toBe(true);
    expect(isNodeRuntime("/usr/bin/node-22.2.0")).toBe(true);
    expect(isNodeRuntime("/usr/bin/node-18.19.1")).toBe(true);
  });

  it("should recognize versioned binaries with .exe extension", () => {
    expect(isNodeRuntime("C:\\node24.exe")).toBe(true);
    expect(isNodeRuntime("C:\\node-22.exe")).toBe(true);
    expect(isNodeRuntime("C:\\node-22.2.0.exe")).toBe(true);
  });

  it("should be case-insensitive", () => {
    expect(isNodeRuntime("/usr/bin/Node")).toBe(true);
    expect(isNodeRuntime("/usr/bin/NODE")).toBe(true);
    expect(isNodeRuntime("/usr/bin/Node24")).toBe(true);
    expect(isNodeRuntime("/usr/bin/NODE-22")).toBe(true);
    expect(isNodeRuntime("C:\\NODEJS.EXE")).toBe(true);
  });

  it("should handle quoted paths", () => {
    expect(isNodeRuntime('"C:\\Program Files\\nodejs\\node.exe"')).toBe(true);
    expect(isNodeRuntime("'/usr/bin/node'")).toBe(true);
  });

  it("should reject non-node runtimes", () => {
    expect(isNodeRuntime("/usr/bin/bun")).toBe(false);
    expect(isNodeRuntime("/usr/bin/deno")).toBe(false);
    expect(isNodeRuntime("/usr/bin/python")).toBe(false);
  });

  it("should reject node-like but different binaries", () => {
    expect(isNodeRuntime("/usr/bin/node-dev")).toBe(false);
    expect(isNodeRuntime("/usr/bin/nodeenv")).toBe(false);
    expect(isNodeRuntime("/usr/bin/nodemon")).toBe(false);
    expect(isNodeRuntime("/usr/bin/node_modules")).toBe(false);
  });
});

describe("isBunRuntime", () => {
  it("should recognize bun binary", () => {
    expect(isBunRuntime("/usr/bin/bun")).toBe(true);
    expect(isBunRuntime("/usr/local/bin/bun")).toBe(true);
    expect(isBunRuntime("C:\\bun.exe")).toBe(true);
  });

  it("should be case-insensitive", () => {
    expect(isBunRuntime("/usr/bin/Bun")).toBe(true);
    expect(isBunRuntime("/usr/bin/BUN")).toBe(true);
    expect(isBunRuntime("C:\\BUN.EXE")).toBe(true);
  });

  it("should reject non-bun runtimes", () => {
    expect(isBunRuntime("/usr/bin/node")).toBe(false);
    expect(isBunRuntime("/usr/bin/deno")).toBe(false);
    expect(isBunRuntime("/usr/bin/bunx")).toBe(false);
  });
});
