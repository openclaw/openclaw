import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveNpmRunner } from "../../scripts/stage-bundled-plugin-runtime-deps.mjs";

describe("resolveNpmRunner", () => {
  it("anchors npm staging to the active node toolchain when npm-cli.js exists", () => {
    const execPath = "/Users/test/.nodenv/versions/24.13.0/bin/node";
    const expectedNpmCliPath = path.resolve(
      path.dirname(execPath),
      "../lib/node_modules/npm/bin/npm-cli.js",
    );

    const runner = resolveNpmRunner({
      execPath,
      existsSync: (candidate: string) => candidate === expectedNpmCliPath,
      platform: "darwin",
    });

    expect(runner).toEqual({
      command: execPath,
      args: [expectedNpmCliPath],
      shell: false,
    });
  });

  it("falls back to bare npm when npm-cli.js is unavailable", () => {
    expect(
      resolveNpmRunner({
        execPath: "/tmp/node",
        existsSync: () => false,
        platform: "linux",
      }),
    ).toEqual({
      command: "npm",
      args: [],
      shell: false,
    });
  });

  it("keeps shell mode for bare npm fallback on Windows", () => {
    expect(
      resolveNpmRunner({
        execPath: "C:\\node\\node.exe",
        existsSync: () => false,
        platform: "win32",
      }),
    ).toEqual({
      command: "npm",
      args: [],
      shell: true,
    });
  });
});
