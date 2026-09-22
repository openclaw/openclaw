// Covers host binary discovery without spawning a resolver.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";

const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: runCommandWithTimeoutMock,
}));

import { detectBinary } from "./detect-binary.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  runCommandWithTimeoutMock.mockReset();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("detectBinary", () => {
  it.skipIf(process.platform === "win32")(
    "matches which for executable, non-executable, directory, and missing fixtures without spawning",
    async () => {
      const root = tempDirs.make("openclaw-binary-path-");
      fs.writeFileSync(path.join(root, "lane-n1-executable"), "", { mode: 0o755 });
      fs.writeFileSync(path.join(root, "lane-n1-not-executable"), "", { mode: 0o644 });
      fs.mkdirSync(path.join(root, "lane-n1-directory"));
      vi.stubEnv("PATH", `${root}${path.delimiter}/usr/bin${path.delimiter}/bin`);
      for (const name of [
        "lane-n1-executable",
        "lane-n1-not-executable",
        "lane-n1-directory",
        "lane-n1-missing",
      ]) {
        let expected = false;
        try {
          expected =
            execFileSync("/usr/bin/which", [name], {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
            }).trim().length > 0;
        } catch {
          // which signals missing or non-executable candidates with a nonzero exit.
        }
        runCommandWithTimeoutMock.mockResolvedValue({
          code: expected ? 0 : 1,
          stdout: expected ? path.join(root, name) : "",
        });
        await expect(detectBinary(name)).resolves.toBe(expected);
      }
      expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    },
  );

  it.each(["openclaw", "openclaw.cmd", "openclaw.custom"])(
    "finds Windows PATH executable %s without spawning where.exe",
    async (name) => {
      const root = tempDirs.make("openclaw-binary-win-path-");
      const file = path.join(root, name === "openclaw" ? "openclaw.cmd" : name);
      fs.writeFileSync(file, "");
      vi.stubEnv("PATH", root);
      vi.stubEnv("PATHEXT", ".EXE;.CMD");
      runCommandWithTimeoutMock.mockResolvedValue({ code: 0, stdout: file });
      await withMockedWindowsPlatform(async () => {
        await expect(detectBinary(name)).resolves.toBe(true);
      });
      expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform === "win32")(
    "observes PATH installs and removals without stale discovery results",
    async () => {
      const root = tempDirs.make("openclaw-binary-refresh-");
      const file = path.join(root, "lane-n1-installed");
      vi.stubEnv("PATH", root);
      runCommandWithTimeoutMock.mockResolvedValue({ code: 1, stdout: "" });
      await expect(detectBinary("lane-n1-installed")).resolves.toBe(false);
      fs.writeFileSync(file, "", { mode: 0o755 });
      runCommandWithTimeoutMock.mockResolvedValue({ code: 0, stdout: file });
      await expect(detectBinary("lane-n1-installed")).resolves.toBe(true);
      fs.unlinkSync(file);
      runCommandWithTimeoutMock.mockResolvedValue({ code: 1, stdout: "" });
      await expect(detectBinary("lane-n1-installed")).resolves.toBe(false);
      expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    },
  );
});

describe("detectBinary explicit paths", () => {
  it("rejects a searchable directory without probing PATH", async () => {
    const { tmpdir } = await import("node:os");
    const root = fs.mkdtempSync(path.join(tmpdir(), "openclaw-binary-dir-"));
    try {
      await expect(detectBinary(root)).resolves.toBe(false);
      expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "observes execution-bit changes without a stale path cache",
    async () => {
      const { tmpdir } = await import("node:os");
      const root = fs.mkdtempSync(path.join(tmpdir(), "openclaw-binary-mode-"));
      const file = path.join(root, "tool");
      try {
        fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
        await expect(detectBinary(file)).resolves.toBe(false);
        fs.chmodSync(file, 0o755);
        await expect(detectBinary(file)).resolves.toBe(true);
        fs.chmodSync(file, 0o644);
        await expect(detectBinary(file)).resolves.toBe(false);
        expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "accepts a file symlink but rejects directory and dangling symlinks",
    async () => {
      const { tmpdir } = await import("node:os");
      const root = fs.mkdtempSync(path.join(tmpdir(), "openclaw-binary-links-"));
      try {
        const executable = path.join(root, "tool");
        const fileLink = path.join(root, "tool-link");
        const dirLink = path.join(root, "directory-link");
        const missingLink = path.join(root, "missing-link");
        fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        fs.symlinkSync(executable, fileLink);
        fs.symlinkSync(root, dirLink);
        fs.symlinkSync(path.join(root, "absent"), missingLink);
        await expect(detectBinary(fileLink)).resolves.toBe(true);
        await expect(detectBinary(dirLink)).resolves.toBe(false);
        await expect(detectBinary(missingLink)).resolves.toBe(false);
        expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("accepts the current native runtime and rejects a missing explicit path", async () => {
    await expect(detectBinary(process.execPath)).resolves.toBe(true);
    await expect(detectBinary(path.join(process.execPath, "absent"))).resolves.toBe(false);
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === "win32")("detectBinary POSIX path traversal", () => {
  it.each(["actual", "decoy"])(
    "matches which when a PATH symlink/.. targets an %s executable",
    async (location) => {
      const root = tempDirs.make("openclaw-detect-path-traversal-");
      const configured = path.join(root, "configured");
      const actual = path.join(root, "actual");
      fs.mkdirSync(configured);
      fs.mkdirSync(path.join(actual, "bin"), { recursive: true });
      fs.symlinkSync(path.join(actual, "bin"), path.join(configured, "alias"));
      fs.writeFileSync(
        path.join(location === "actual" ? actual : configured, "lane-n1-traversal"),
        "",
        { mode: 0o755 },
      );
      vi.stubEnv("PATH", `${configured}/alias/..`);
      let expected = false;
      try {
        expected =
          execFileSync("/usr/bin/which", ["lane-n1-traversal"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim().length > 0;
      } catch {
        // A lexical decoy must not satisfy lookup through the symlink's real parent.
      }

      await expect(detectBinary("lane-n1-traversal")).resolves.toBe(expected);
      expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    },
  );

  it.each(["/", "//", "/.", "/../tool"])(
    "does not erase an invalid executable suffix: %s",
    async (suffix) => {
      const { tmpdir } = await import("node:os");
      const root = fs.mkdtempSync(path.join(tmpdir(), "openclaw-binary-suffix-"));
      try {
        const file = path.join(root, "tool");
        const link = path.join(root, "tool-link");
        fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        fs.symlinkSync(file, link);
        // Do not use path.join: it would remove the invalid suffix from the fixture.
        // macOS can reuse a successful X_OK lookup for later file/../ traversal.
        // Check rejection before the positive controls warm that native lookup.
        await expect(detectBinary(`${file}${suffix}`)).resolves.toBe(false);
        await expect(detectBinary(`${link}${suffix}`)).resolves.toBe(false);
        await expect(detectBinary(file)).resolves.toBe(true);
        await expect(detectBinary(link)).resolves.toBe(true);
        expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["absolute", "relative"])(
    "follows the filesystem parent of a symlink in a %s path",
    async (form) => {
      const { tmpdir } = await import("node:os");
      const root = fs.mkdtempSync(path.join(tmpdir(), "openclaw-binary-parent-"));
      try {
        const configured = path.join(root, "configured");
        const actual = path.join(root, "actual");
        fs.mkdirSync(configured);
        fs.mkdirSync(path.join(actual, "bin"), { recursive: true });
        fs.writeFileSync(path.join(actual, "tool"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        fs.symlinkSync(path.join(actual, "bin"), path.join(configured, "alias"));
        const prefix = form === "relative" ? path.relative(process.cwd(), configured) : configured;
        const input = `${prefix}/alias/../tool`;
        expect(fs.realpathSync.native(input)).toBe(
          fs.realpathSync.native(path.join(actual, "tool")),
        );
        expect(fs.existsSync(path.resolve(input))).toBe(false);
        await expect(detectBinary(input)).resolves.toBe(true);
        expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["missing", "non-executable"])(
    "does not accept a lexical decoy when the filesystem target is %s",
    async (state) => {
      const { tmpdir } = await import("node:os");
      const root = fs.mkdtempSync(path.join(tmpdir(), "openclaw-binary-decoy-"));
      try {
        const configured = path.join(root, "configured");
        const actual = path.join(root, "actual");
        fs.mkdirSync(configured);
        fs.mkdirSync(path.join(actual, "bin"), { recursive: true });
        const decoy = path.join(configured, "tool");
        fs.writeFileSync(decoy, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        if (state === "non-executable") {
          fs.writeFileSync(path.join(actual, "tool"), "not executable\n", { mode: 0o644 });
        }
        fs.symlinkSync(path.join(actual, "bin"), path.join(configured, "alias"));
        const input = `${configured}/alias/../tool`;
        expect(path.resolve(input)).toBe(decoy);
        await expect(detectBinary(decoy)).resolves.toBe(true);
        await expect(detectBinary(input)).resolves.toBe(false);
        expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
