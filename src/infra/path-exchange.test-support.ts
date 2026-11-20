import fs from "node:fs";

/**
 * The route a path exchange takes first in this environment, or null where none
 * exists: macOS always ships osascript, Linux has the system perl on the two
 * architectures whose system call number is known, and a Node with FFI goes first.
 */
export const expectedPathExchangeRoute: string | null =
  process.platform !== "darwin" && process.platform !== "linux"
    ? null
    : process.allowedNodeEnvironmentFlags.has("--experimental-ffi")
      ? "node:ffi"
      : process.platform === "darwin"
        ? "osascript"
        : fs.existsSync("/usr/bin/perl") && (process.arch === "x64" || process.arch === "arm64")
          ? "perl"
          : null;
