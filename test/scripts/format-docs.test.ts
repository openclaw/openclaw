import path from "node:path";
import { describe, expect, it } from "vitest";
import { createOxfmtSpawnSpec, docsFiles, runOxfmt } from "../../scripts/format-docs.mjs";

describe("format-docs", () => {
  it("wraps the local oxfmt.cmd shim through cmd.exe on Windows", () => {
    const spec = createOxfmtSpawnSpec(["--write", "README.md"], {
      comSpec: "C:\\Windows\\System32\\cmd.exe",
      platform: "win32",
      root: "C:\\repo",
    });

    expect(spec).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        `${path.win32.join("C:\\repo", "node_modules", ".bin", "oxfmt")}.cmd --write README.md`,
      ],
      windowsVerbatimArguments: true,
    });
  });

  it("uses the npm-installed oxfmt binary on non-Windows platforms", () => {
    expect(
      createOxfmtSpawnSpec(["--write", "README.md"], {
        platform: "linux",
        root: "/repo",
      }),
    ).toEqual({
      command: "/repo/node_modules/.bin/oxfmt",
      args: ["--write", "README.md"],
    });
  });

  it("reports oxfmt launch failures", () => {
    expect(() =>
      runOxfmt(["README.md"], {
        config: "/repo/.oxfmtrc.jsonc",
        platform: "linux",
        root: "/repo",
        spawnSync: () => ({
          error: new Error("spawn ENOENT"),
          status: null,
          signal: null,
          stderr: "",
          stdout: "",
        }),
      }),
    ).toThrow("failed to launch oxfmt: spawn ENOENT");
  });

  it("reports git launch failures while listing docs files", () => {
    expect(() =>
      docsFiles({
        root: "/repo",
        spawnSync: () => ({
          error: new Error("spawn ENOENT"),
          status: null,
          signal: null,
          stderr: "",
          stdout: "",
        }),
      }),
    ).toThrow("failed to launch git: spawn ENOENT while listing docs files");
  });
});
