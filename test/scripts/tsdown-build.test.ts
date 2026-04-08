import { describe, expect, it } from "vitest";
import { resolveTsdownBuildInvocation } from "../../scripts/tsdown-build.mjs";

describe("resolveTsdownBuildInvocation", () => {
  it("routes Windows tsdown builds through the pnpm runner instead of shell=true", () => {
    const result = resolveTsdownBuildInvocation({
      platform: "win32",
      nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
      npmExecPath: "C:/Users/test/AppData/Local/pnpm/10.32.1/bin/pnpm.cjs",
      env: {},
    });

    expect(result).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "C:/Users/test/AppData/Local/pnpm/10.32.1/bin/pnpm.cjs",
        "exec",
        "tsdown",
        "--config-loader",
        "unrun",
        "--logLevel",
        "warn",
      ],
      options: {
        encoding: "utf8",
        stdio: "pipe",
        shell: false,
        windowsVerbatimArguments: undefined,
        env: {},
      },
    });
  });
});
