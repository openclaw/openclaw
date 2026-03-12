import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPnpmInvocation,
  resolvePnpmRunner,
  resolvePnpmRunnerOrThrow,
  shouldUseShellForCommand,
} from "../../scripts/package-runner.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scripts/package-runner", () => {
  it("prefers pnpm when a direct binary is on PATH", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pnpm-runner-"));
    try {
      const pnpmPath = path.join(tempDir, "pnpm");
      fs.writeFileSync(pnpmPath, "#!/bin/sh\n", "utf8");
      fs.chmodSync(pnpmPath, 0o755);

      const runner = resolvePnpmRunner({
        env: { PATH: tempDir },
        platform: "linux",
      });

      expect(runner).toEqual({
        command: pnpmPath,
        prefixArgs: [],
        shell: false,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to corepack when pnpm is missing", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-corepack-runner-"));
    try {
      const corepackPath = path.join(tempDir, "corepack");
      fs.writeFileSync(corepackPath, "#!/bin/sh\n", "utf8");
      fs.chmodSync(corepackPath, 0o755);

      const runner = resolvePnpmRunner({
        env: { PATH: tempDir },
        platform: "linux",
      });

      expect(runner).toEqual({
        command: corepackPath,
        prefixArgs: ["pnpm"],
        shell: false,
      });
      expect(buildPnpmInvocation(runner!, ["vitest", "run"])).toEqual({
        command: corepackPath,
        args: ["pnpm", "vitest", "run"],
        shell: false,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("throws when neither pnpm nor corepack can be found", () => {
    expect(() =>
      resolvePnpmRunnerOrThrow({
        env: { PATH: "/__openclaw_missing__/bin" },
        platform: "linux",
      }),
    ).toThrow(/missing pnpm or corepack/i);
  });

  it("detects Windows command launchers that require shell mode", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      const target = typeof candidate === "string" ? candidate : candidate.toString();
      return target === "C:\\Tools\\pnpm.CMD";
    });

    const runner = resolvePnpmRunner({
      env: {
        Path: "C:\\Tools",
        PATHEXT: ".EXE;.CMD;.BAT",
      },
      platform: "win32",
    });

    expect(runner).toEqual({
      command: "C:\\Tools\\pnpm.CMD",
      prefixArgs: [],
      shell: true,
    });
    expect(shouldUseShellForCommand("C:\\Tools\\pnpm.CMD", "win32")).toBe(true);
  });
});
