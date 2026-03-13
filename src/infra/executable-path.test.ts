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
    const execPath = path.join(base, "tool");
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
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });

    const pathTool = path.join(binDir, "runner");
    const cwdTool = path.join(cwd, "local-tool");
    await fs.writeFile(pathTool, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.writeFile(cwdTool, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(pathTool, 0o755);
    await fs.chmod(cwdTool, 0o755);

    expect(resolveExecutableFromPathEnv("runner", `${binDir}${path.delimiter}/usr/bin`)).toBe(
      pathTool,
    );
    expect(resolveExecutableFromPathEnv("missing", binDir)).toBeUndefined();
    expect(resolveExecutablePath("./local-tool", { cwd })).toBe(cwdTool);
    expect(resolveExecutablePath("runner", { env: { PATH: binDir } })).toBe(pathTool);
    expect(resolveExecutablePath("missing", { env: { PATH: binDir } })).toBeUndefined();
  });
});
