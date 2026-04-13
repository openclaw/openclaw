import { describe, expect, it } from "vitest";
import {
  resolveDaemonInstallRuntimeInputs,
  resolveDaemonNodeBinDir,
  resolveGatewayDevMode,
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
  it("includes the vite-plus companion bin for vite-plus managed runtimes", () => {
    expect(
      resolveDaemonNodeBinDir("/Users/test/.vite-plus/js_runtime/node/24.14.1/bin/node"),
    ).toEqual(["/Users/test/.vite-plus/js_runtime/node/24.14.1/bin", "/Users/test/.vite-plus/bin"]);
  });

  it("returns the absolute node bin directory", () => {
    expect(resolveDaemonNodeBinDir("/custom/node/bin/node")).toEqual(["/custom/node/bin"]);
  });

  it("ignores bare executable names", () => {
    expect(resolveDaemonNodeBinDir("node")).toBeUndefined();
  });
});
