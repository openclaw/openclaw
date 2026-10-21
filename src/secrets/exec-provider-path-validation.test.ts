import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withMockedWindowsAclVerificationUnavailable } from "../test-utils/vitest-spies.js";
import { assertSecureExecCommandPath } from "./exec-provider-path-validation.js";

describe("exec provider command path validation", () => {
  const itPosix = it.skipIf(process.platform === "win32");
  let fixtureRoot = "";
  let validExecutablePath = "";
  let executionMarkerPath = "";
  let caseId = 0;
  const createCaseDir = async (label: string): Promise<string> => {
    const dir = path.join(fixtureRoot, `${label}-${caseId++}`);
    await fs.mkdir(dir);
    return dir;
  };
  const check = (command: string, trustedDirs?: string[]) =>
    assertSecureExecCommandPath({
      command,
      label: "secrets.providers.execmain.command",
      trustedDirs,
    });
  const createScript = async (label: string, contents: string, mode: number) => {
    const scriptPath = path.join(await createCaseDir(label), "helper");
    await fs.writeFile(scriptPath, contents);
    await fs.chmod(scriptPath, mode);
    return scriptPath;
  };

  beforeAll(async () => {
    fixtureRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "exec-provider-path-validation-")),
    );
    validExecutablePath = path.join(fixtureRoot, "valid-executable");
    executionMarkerPath = path.join(fixtureRoot, "executed");
    await fs.writeFile(
      validExecutablePath,
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(executionMarkerPath)}, "executed");\n`,
    );
    await fs.chmod(validExecutablePath, 0o755);
  });
  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("accepts a valid regular executable without executing it", async () => {
    const securePath = await check(validExecutablePath);
    expect(securePath).toBe(validExecutablePath);
    await expect(fs.access(executionMarkerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  itPosix("rejects missing command paths", async () => {
    const root = await createCaseDir("missing");
    await expect(check(path.join(root, "no-such-binary"))).rejects.toThrow("is not readable");
  });

  itPosix("rejects directory command paths", async () => {
    const root = await createCaseDir("dir");
    await expect(check(root)).rejects.toThrow("must be a file");
  });

  itPosix("rejects symlinked command paths", async () => {
    const root = await createCaseDir("link");
    const symlinkPath = path.join(root, "exec-link");
    await fs.symlink(validExecutablePath, symlinkPath);
    await expect(check(symlinkPath)).rejects.toThrow("must not be a symlink");
  });

  itPosix("rejects world-writable command paths", async () => {
    const scriptPath = await createScript("writable", "#!/bin/sh\nexit 0\n", 0o666);
    await expect(check(scriptPath)).rejects.toThrow("permissions are too open");
  });

  itPosix("accepts regular files lacking the owner-execute bit (startup parity)", async () => {
    const scriptPath = await createScript("non-exec", "not executable\n", 0o600);
    await expect(check(scriptPath)).resolves.toBe(scriptPath);
  });

  itPosix("rejects commands outside trustedDirs", async () => {
    const root = await createCaseDir("trusted");
    const trustedDir = path.join(root, "trusted");
    await fs.mkdir(trustedDir);
    await expect(check(validExecutablePath, [trustedDir])).rejects.toThrow(
      "is outside trustedDirs",
    );
  });

  itPosix("accepts a regular command inside trustedDirs", async () => {
    const copy = await createScript("trusted-ok", "#!/bin/sh\nexit 1\n", 0o755);
    await expect(check(copy, [path.dirname(copy)])).resolves.toBe(copy);
  });

  it("fails closed with a supported recovery message when Windows ACL verification is unavailable", async () => {
    await withMockedWindowsAclVerificationUnavailable(
      path.join(fixtureRoot, "missing-windows-system-root"),
      async () => {
        await expect(check(validExecutablePath)).rejects.toMatchObject({
          code: "permission-unverified",
          message: expect.stringMatching(
            /ACL verification unavailable on Windows.*no provider-level bypass/,
          ),
        });
      },
    );
  });
});
