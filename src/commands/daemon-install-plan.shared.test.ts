import { describe, expect, it } from "vitest";
import {
  resolveDaemonExtraPathDirs,
  resolveDaemonInstallRuntimeInputs,
  resolveDaemonNodeBinDir,
  resolveGatewayDevMode,
  resolveOpenclawBinDir,
} from "./daemon-install-plan.shared.js";

describe("resolveGatewayDevMode", () => {
  it("detects src ts entrypoints", () => {
    expect(resolveGatewayDevMode(["node", "/Users/me/openclaw/src/cli/index.ts"])).toBe(true);
    expect(resolveGatewayDevMode(["node", "C:\\Users\\me\\openclaw\\src\\cli\\index.ts"])).toBe(
      true,
    );
    expect(resolveGatewayDevMode(["node", "/Users/me/openclaw/dist/cli/index.js"])).toBe(false);
  });
});

describe("resolveDaemonInstallRuntimeInputs", () => {
  it("keeps explicit devMode and nodePath overrides", async () => {
    await expect(
      resolveDaemonInstallRuntimeInputs({
        env: {},
        runtime: "node",
        devMode: false,
        nodePath: "/custom/node",
      }),
    ).resolves.toEqual({
      devMode: false,
      nodePath: "/custom/node",
    });
  });
});

describe("resolveDaemonNodeBinDir", () => {
  it("returns the absolute node bin directory", () => {
    expect(resolveDaemonNodeBinDir("/custom/node/bin/node")).toEqual(["/custom/node/bin"]);
  });

  it("ignores bare executable names", () => {
    expect(resolveDaemonNodeBinDir("node")).toBeUndefined();
  });
});

describe("resolveOpenclawBinDir", () => {
  // Regression for #84201: on macOS, getMinimalServicePathParts intentionally omits
  // user bin directories like ~/.npm-global/bin, so the gateway's service PATH does
  // not include the install-time openclaw binary on prefix-based installs. Detecting
  // the directory at install time keeps it on the supervised PATH for child processes.
  it("returns the first PATH segment containing an openclaw binary (npm-global on darwin)", () => {
    const result = resolveOpenclawBinDir({
      platform: "darwin",
      env: {
        PATH: "/Users/u/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      },
      existsSync: (candidate) => candidate === "/Users/u/.npm-global/bin/openclaw",
    });
    expect(result).toEqual(["/Users/u/.npm-global/bin"]);
  });

  it("returns undefined when openclaw is not on PATH", () => {
    expect(
      resolveOpenclawBinDir({
        platform: "darwin",
        env: { PATH: "/usr/bin:/bin" },
        existsSync: () => false,
      }),
    ).toBeUndefined();
  });

  it("returns undefined when PATH is unset", () => {
    expect(
      resolveOpenclawBinDir({
        platform: "darwin",
        env: {},
        existsSync: () => true,
      }),
    ).toBeUndefined();
  });

  it("skips relative PATH segments and resolves the first absolute match", () => {
    const result = resolveOpenclawBinDir({
      platform: "linux",
      env: { PATH: "./local-bin:/usr/local/bin" },
      existsSync: () => true,
    });
    expect(result).toEqual(["/usr/local/bin"]);
  });

  it("matches windows-style executable extensions", () => {
    expect(
      resolveOpenclawBinDir({
        platform: "win32",
        env: { PATH: "C:\\Tools;C:\\Apps\\openclaw" },
        existsSync: (candidate) => candidate === "C:\\Apps\\openclaw\\openclaw.cmd",
      }),
    ).toEqual(["C:\\Apps\\openclaw"]);
  });
});

describe("resolveDaemonExtraPathDirs", () => {
  // Regression for #84201: extraPathDirs is the only knob that adds entries to the
  // narrow darwin service PATH. It must surface both the openclaw bin dir (so
  // gateway children can call back into the CLI) and the node bin dir (so they can
  // find sibling toolchain binaries).
  it("combines openclaw bin dir and node bin dir without duplicates", () => {
    const result = resolveDaemonExtraPathDirs({
      nodePath: "/opt/homebrew/opt/node/bin/node",
      platform: "darwin",
      env: { PATH: "/Users/u/.npm-global/bin:/opt/homebrew/bin" },
      existsSync: (candidate) => candidate === "/Users/u/.npm-global/bin/openclaw",
    });
    expect(result).toEqual(["/Users/u/.npm-global/bin", "/opt/homebrew/opt/node/bin"]);
  });

  it("emits a single entry when node and openclaw share a bin dir", () => {
    const result = resolveDaemonExtraPathDirs({
      nodePath: "/opt/homebrew/bin/node",
      platform: "darwin",
      env: { PATH: "/opt/homebrew/bin" },
      existsSync: (candidate) => candidate === "/opt/homebrew/bin/openclaw",
    });
    expect(result).toEqual(["/opt/homebrew/bin"]);
  });

  it("returns undefined when neither dir can be resolved", () => {
    expect(
      resolveDaemonExtraPathDirs({
        nodePath: "node",
        platform: "darwin",
        env: { PATH: "/usr/bin" },
        existsSync: () => false,
      }),
    ).toBeUndefined();
  });
});
