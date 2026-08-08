/** Tests the non-executing exec-provider command-path validator (see #117051). */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import { assertSecureExecCommandPath } from "./exec-provider-path-validation.js";

describe("exec provider command path validation", () => {
  const isWindows = process.platform === "win32";
  function itPosix(name: string, fn: () => Promise<void> | void) {
    it.skipIf(isWindows)(name, fn);
  }
  let fixtureRoot = "";
  let validExecutablePath = "";
  let caseId = 0;
  const createCaseDir = async (label: string): Promise<string> => {
    const dir = path.join(fixtureRoot, `${label}-${caseId++}`);
    await fs.mkdir(dir);
    return dir;
  };

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "exec-provider-path-validation-"));
    // Copy the runtime executable so the fixture is a regular file with closed
    // permissions on every platform (hosted-runner node binaries can be
    // world-writable, which the validator correctly rejects).
    validExecutablePath = path.join(fixtureRoot, "valid-executable");
    await fs.copyFile(process.execPath, validExecutablePath);
    await fs.chmod(validExecutablePath, 0o755);
  });
  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("accepts a valid regular executable without executing it", async () => {
    const securePath = await assertSecureExecCommandPath({
      command: validExecutablePath,
      label: "secrets.providers.execmain.command",
    });
    expect(securePath).toBe(validExecutablePath);
  });

  itPosix("rejects missing command paths", async () => {
    const root = await createCaseDir("missing");
    await expect(
      assertSecureExecCommandPath({
        command: path.join(root, "no-such-binary"),
        label: "secrets.providers.execmain.command",
      }),
    ).rejects.toThrow("is not readable");
  });

  itPosix("rejects directory command paths", async () => {
    const root = await createCaseDir("dir");
    await expect(
      assertSecureExecCommandPath({
        command: root,
        label: "secrets.providers.execmain.command",
      }),
    ).rejects.toThrow("must be a file");
  });

  itPosix("rejects symlinked command paths", async () => {
    const root = await createCaseDir("link");
    const symlinkPath = path.join(root, "exec-link");
    await fs.symlink(process.execPath, symlinkPath);
    await expect(
      assertSecureExecCommandPath({
        command: symlinkPath,
        label: "secrets.providers.execmain.command",
      }),
    ).rejects.toThrow("must not be a symlink");
  });

  itPosix("rejects world-writable command paths", async () => {
    const root = await createCaseDir("writable");
    const scriptPath = path.join(root, "helper");
    await fs.writeFile(scriptPath, "#!/bin/sh\nexit 0\n");
    await fs.chmod(scriptPath, 0o666);
    await expect(
      assertSecureExecCommandPath({
        command: scriptPath,
        label: "secrets.providers.execmain.command",
      }),
    ).rejects.toThrow("permissions are too open");
  });

  itPosix("rejects regular files lacking the owner-execute bit", async () => {
    const root = await createCaseDir("non-exec");
    const scriptPath = path.join(root, "not-executable");
    await fs.copyFile(process.execPath, scriptPath);
    // Readable, owner-owned, not world/group-writable, but NOT executable.
    await fs.chmod(scriptPath, 0o600);
    await expect(
      assertSecureExecCommandPath({
        command: scriptPath,
        label: "secrets.providers.execmain.command",
      }),
    ).rejects.toThrow("must be executable by its owner");
  });

  itPosix("rejects non-regular command targets (FIFO)", async () => {
    const root = await createCaseDir("fifo");
    const fifoPath = path.join(root, "exec-fifo");
    execFileSync("mkfifo", [fifoPath]);
    await expect(
      assertSecureExecCommandPath({
        command: fifoPath,
        label: "secrets.providers.execmain.command",
      }),
    ).rejects.toThrow("must be a regular file");
  });

  itPosix("rejects commands outside trustedDirs", async () => {
    const root = await createCaseDir("trusted");
    const trustedDir = path.join(root, "trusted");
    await fs.mkdir(trustedDir);
    await expect(
      assertSecureExecCommandPath({
        command: process.execPath,
        label: "secrets.providers.execmain.command",
        trustedDirs: [trustedDir],
      }),
    ).rejects.toThrow("is outside trustedDirs");
  });

  itPosix("accepts a regular command inside trustedDirs", async () => {
    const root = await createCaseDir("trusted-ok");
    const trustedDir = path.join(root, "trusted");
    await fs.mkdir(trustedDir, { recursive: true });
    const copy = path.join(trustedDir, "node");
    await fs.copyFile(process.execPath, copy);
    await fs.chmod(copy, 0o755);
    await expect(
      assertSecureExecCommandPath({
        command: copy,
        label: "secrets.providers.execmain.command",
        trustedDirs: [trustedDir],
      }),
    ).resolves.toBe(copy);
  });

  it("fails closed with a supported recovery message when Windows ACL verification is unavailable", async () => {
    // On a POSIX host, mocking process.platform to win32 makes the real
    // inspectPathPermissions attempt Windows ACL inspection and return
    // source="unknown" (icacls is unavailable), which exercises the Windows
    // fail-closed branch without a Windows runner.
    await withMockedWindowsPlatform(async () => {
      try {
        await assertSecureExecCommandPath({
          command: process.execPath,
          label: "secrets.providers.execmain.command",
        });
        expect.unreachable("expected the Windows ACL check to fail closed");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toMatch(/ACL verification is unavailable on Windows/);
        expect(message).toMatch(/fails closed/);
        // The retired allowInsecurePath opt-out must not be proposed.
        expect(message).not.toMatch(/allowInsecurePath/);
      }
    });
  });
});
