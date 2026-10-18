// Daemon runtime binary tests cover runtime executable resolution.
import { describe, expect, it } from "vitest";
import { isBunRuntime, isNodeRuntime } from "./runtime-binary.js";

describe("isNodeRuntime", () => {
  it("rejects non-node runtimes", () => {
    expect(isNodeRuntime("/usr/bin/bun")).toBe(false);
    expect(isNodeRuntime("/usr/bin/node-dev")).toBe(false);
    expect(isNodeRuntime("/usr/bin/nodeenv")).toBe(false);
    expect(isNodeRuntime("/usr/bin/nodemon")).toBe(false);
  });
});

describe("isBunRuntime", () => {
  it("rejects non-bun runtimes", () => {
    expect(isBunRuntime("/usr/bin/node")).toBe(false);
    expect(isBunRuntime("/usr/bin/bunx")).toBe(false);
  });
});
