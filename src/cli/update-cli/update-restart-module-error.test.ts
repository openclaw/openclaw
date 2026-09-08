import path from "node:path";
import { describe, expect, it } from "vitest";
import { isReplacedInstallModuleError } from "./update-restart-module-error.js";

const INSTALL_ROOT = path.join("/opt", "node_modules", "openclaw");

function enoent(filePath: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(
    `ENOENT: no such file or directory, open '${filePath}'`,
  );
  err.code = "ENOENT";
  err.path = filePath;
  return err;
}

describe("isReplacedInstallModuleError", () => {
  it("recognizes a hashed dist chunk that the install swap removed", () => {
    // The exact shape observed when an update swapped 2026.9.1 -> 2026.9.2 and the
    // still-running updater lazily imported a chunk that only the old tree had.
    const err = enoent(path.join(INSTALL_ROOT, "dist", "shared-DFJEouXv.js"));

    expect(isReplacedInstallModuleError(err, INSTALL_ROOT)).toBe(true);
  });

  it("recognizes an ESM loader ERR_MODULE_NOT_FOUND inside the install root", () => {
    const err: NodeJS.ErrnoException = new Error(
      `Cannot find module '${path.join(INSTALL_ROOT, "dist", "gateway-call-abc123.js")}'`,
    );
    err.code = "ERR_MODULE_NOT_FOUND";

    expect(isReplacedInstallModuleError(err, INSTALL_ROOT)).toBe(true);
  });

  it("ignores a missing file outside the install root", () => {
    // The user's own config or state going missing is a real failure, not our swap.
    const err = enoent(path.join("/home", "someone", ".openclaw", "openclaw.json"));

    expect(isReplacedInstallModuleError(err, INSTALL_ROOT)).toBe(false);
  });

  it("does not excuse a missing data file inside the install root", () => {
    // Only lazily-imported code disappears this way. A missing package.json means
    // the installation itself is broken, and must not be waved through.
    const err = enoent(path.join(INSTALL_ROOT, "package.json"));

    expect(isReplacedInstallModuleError(err, INSTALL_ROOT)).toBe(false);
  });

  it("ignores an ordinary restart failure", () => {
    expect(isReplacedInstallModuleError(new Error("restart unavailable"), INSTALL_ROOT)).toBe(
      false,
    );
  });

  it("ignores a missing-module error when the install root is unknown", () => {
    // Without a root to compare against there is no evidence the swap caused it,
    // so the safe reading is "a real failure".
    const err = enoent(path.join(INSTALL_ROOT, "dist", "shared-DFJEouXv.js"));

    expect(isReplacedInstallModuleError(err, undefined)).toBe(false);
  });
});
