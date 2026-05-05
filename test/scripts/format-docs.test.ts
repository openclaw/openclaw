import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createOxfmtSpawnSpec,
  docsFiles,
  oxfmtFileBatches,
  runOxfmt,
} from "../../scripts/format-docs.mjs";

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

  it("batches Windows docs files under the cmd.exe command line limit", () => {
    const files = Array.from(
      { length: 24 },
      (_, index) =>
        `C:\\Users\\contributor\\AppData\\Local\\Temp\\openclaw-docs-format-test\\docs\\section-${index}\\long-file-name-${index}.mdx`,
    );
    const params = {
      comSpec: "C:\\Windows\\System32\\cmd.exe",
      config: "C:\\repo\\.oxfmtrc.jsonc",
      maxWindowsCommandLineLength: 1000,
      platform: "win32",
      root: "C:\\repo",
    };

    const batches = oxfmtFileBatches(files, params);

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(files);
    for (const batch of batches) {
      const spec = createOxfmtSpawnSpec(
        ["--write", "--threads=1", "--config", params.config, ...batch],
        params,
      );
      expect([spec.command, ...spec.args].join(" ").length).toBeLessThanOrEqual(
        params.maxWindowsCommandLineLength,
      );
    }
  });

  it("runs one oxfmt process per Windows batch", () => {
    const commands: string[] = [];

    runOxfmt(
      Array.from(
        { length: 10 },
        (_, index) =>
          `C:\\Users\\contributor\\AppData\\Local\\Temp\\openclaw-docs-format-test\\docs\\guide-${index}.mdx`,
      ),
      {
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        config: "C:\\repo\\.oxfmtrc.jsonc",
        maxWindowsCommandLineLength: 800,
        platform: "win32",
        root: "C:\\repo",
        spawnSync: (command: string, args: string[]) => {
          commands.push([command, ...args].join(" "));
          return {
            error: undefined,
            status: 0,
            signal: null,
            stderr: "",
            stdout: "",
          };
        },
      },
    );

    expect(commands.length).toBeGreaterThan(1);
    expect(commands.every((command) => command.length <= 800)).toBe(true);
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
