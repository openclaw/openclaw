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
      env: {},
      existsSync: (candidate: string) => candidate === expectedNpmCliPath,
      platform: "darwin",
    });

    expect(runner).toEqual({
      command: execPath,
      args: [expectedNpmCliPath],
      shell: false,
    });
  });

  it("prefixes PATH with the active node dir when falling back to bare npm", () => {
    expect(
      resolveNpmRunner({
        execPath: "/tmp/node",
        env: {
          PATH: "/usr/bin:/bin",
        },
        existsSync: () => false,
        platform: "linux",
      }),
    ).toEqual({
      command: "npm",
      args: [],
      shell: false,
      env: {
        PATH: `/tmp${path.delimiter}/usr/bin:/bin`,
      },
    });
  });

  it("keeps shell mode for bare npm fallback on Windows", () => {
    expect(
      resolveNpmRunner({
        execPath: "C:\\node\\node.exe",
        env: {
          Path: "C:\\Windows\\System32",
        },
        existsSync: () => false,
        platform: "win32",
      }),
    ).toEqual({
      command: "npm",
      args: [],
      shell: true,
      env: {
        Path: "C:\\node;C:\\Windows\\System32",
      },
    });
  });
});
