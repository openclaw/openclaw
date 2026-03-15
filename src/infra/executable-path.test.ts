import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isExecutableFile,
  resolveExecutableFromPathEnv,
  resolveExecutablePath,
} from "./executable-path.js";

describe("executable path helpers", () => {
  it("detects executable files and rejects directories or non-executables", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-path-"));
    const executableSuffix = process.platform === "win32" ? ".cmd" : "";
    const execPath = path.join(base, `tool${executableSuffix}`);
    const filePath = path.join(base, "plain.txt");
    const dirPath = path.join(base, "dir");
    await fs.writeFile(execPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(execPath, 0o755);
    await fs.writeFile(filePath, "nope", "utf8");
    await fs.mkdir(dirPath);

    expect(isExecutableFile(execPath)).toBe(true);
    expect(isExecutableFile(filePath)).toBe(false);
    expect(isExecutableFile(dirPath)).toBe(false);
    expect(isExecutableFile(path.join(base, "missing"))).toBe(false);
  });

  it("resolves executables from PATH entries and cwd-relative paths", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-path-"));
    const binDir = path.join(base, "bin");
    const cwd = path.join(base, "cwd");
    const executableSuffix = process.platform === "win32" ? ".cmd" : "";
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });

    const pathTool = path.join(binDir, `runner${executableSuffix}`);
    const cwdTool = path.join(cwd, `local-tool${executableSuffix}`);
    await fs.writeFile(pathTool, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.writeFile(cwdTool, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(pathTool, 0o755);
    await fs.chmod(cwdTool, 0o755);

    expect(resolveExecutableFromPathEnv("runner", `${binDir}${path.delimiter}/usr/bin`)).toBe(
      pathTool,
    );
    expect(resolveExecutableFromPathEnv("missing", binDir)).toBeUndefined();
    expect(resolveExecutablePath(`./local-tool${executableSuffix}`, { cwd })).toBe(cwdTool);
    expect(resolveExecutablePath("runner", { env: { PATH: binDir } })).toBe(pathTool);
    expect(resolveExecutablePath("missing", { env: { PATH: binDir } })).toBeUndefined();
  });

  it("resolves absolute, home-relative, and Path-cased env executables", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-path-"));
    const homeDir = path.join(base, "home");
    const binDir = path.join(base, "bin");
    const executableSuffix = process.platform === "win32" ? ".cmd" : "";
    await fs.mkdir(homeDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });

    const homeTool = path.join(homeDir, `home-tool${executableSuffix}`);
    const absoluteTool = path.join(base, `absolute-tool${executableSuffix}`);
    const pathTool = path.join(binDir, `runner${executableSuffix}`);
    await fs.writeFile(homeTool, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.writeFile(absoluteTool, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.writeFile(pathTool, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(homeTool, 0o755);
    await fs.chmod(absoluteTool, 0o755);
    await fs.chmod(pathTool, 0o755);

    expect(resolveExecutablePath(absoluteTool)).toBe(absoluteTool);
    expect(
      path.normalize(
        resolveExecutablePath(`~/home-tool${executableSuffix}`, { env: { HOME: homeDir } }) ?? "",
      ),
    ).toBe(path.normalize(homeTool));
    expect(path.normalize(resolveExecutablePath("runner", { env: { Path: binDir } }) ?? "")).toBe(
      path.normalize(pathTool),
    );
    expect(
      resolveExecutablePath(`~/missing-tool${executableSuffix}`, { env: { HOME: homeDir } }),
    ).toBeUndefined();
  });
});
