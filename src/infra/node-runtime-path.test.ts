import path from "node:path";
import { describe, expect, it } from "vitest";
import { withNodeRuntimePath } from "../../node-runtime-env.mjs";

const nodePath = path.resolve("/runtime/node/node");

describe("withNodeRuntimePath", () => {
  it("prepends the runtime directory to a single PATH key", () => {
    const result = withNodeRuntimePath({ PATH: "/usr/local/bin:/usr/bin" }, nodePath, "linux");

    expect(result).toEqual({
      PATH: `${path.posix.dirname(nodePath)}:/usr/local/bin:/usr/bin`,
    });
  });

  it("does not duplicate an existing runtime directory entry", () => {
    const runtimeDir = path.posix.dirname(nodePath);
    const result = withNodeRuntimePath({ PATH: `${runtimeDir}:/usr/bin` }, nodePath, "linux");

    expect(result).toEqual({ PATH: `${runtimeDir}:/usr/bin` });
  });

  it("creates PATH when the environment has none", () => {
    const result = withNodeRuntimePath({ HOME: "/home/node" }, nodePath, "linux");

    expect(result).toEqual({
      HOME: "/home/node",
      PATH: path.posix.dirname(nodePath),
    });
  });

  it("merges differently cased PATH keys on Win32 instead of dropping one", () => {
    const result = withNodeRuntimePath(
      { PATH: "C:\\system32", Path: "C:\\tools", HOME: "C:\\home" },
      "C:\\runtime\\node.exe",
      "win32",
    );

    expect(result).toEqual({
      PATH: "C:\\runtime;C:\\system32;C:\\tools",
      Path: "C:\\runtime;C:\\system32;C:\\tools",
      HOME: "C:\\home",
    });
  });
});
