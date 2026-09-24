import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as processExec from "../process/exec.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { assertPacmanUnowned, inspectPacmanOwnership } from "./update-pacman.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
const success = {
  stdout: "",
  stderr: "",
  code: 0,
  signal: null,
  killed: false,
  termination: "exit" as const,
};
beforeEach(async () => {
  root = dirs.make("update-pacman-");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw"}');
  await fs.writeFile(path.join(root, "openclaw.mjs"), "// fixture");
  const access = fs.access.bind(fs);
  vi.spyOn(fs, "access").mockImplementation(async (file, mode) => {
    if (file !== "/usr/bin/pacman") {
      return access(file, mode);
    }
  });
});
afterEach(() => vi.restoreAllMocks());

it("permits a user install only when pacman reports its files unowned", async () => {
  vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv) => ({
    ...success,
    code: 1,
    stderr: `error: No package owns ${argv.at(-1)}\n`,
  }));
  await withMockedPlatform("linux", async () => {
    await expect(inspectPacmanOwnership(root)).resolves.toBeNull();
  });
});

it("protects an owned launcher when the package manifest is unowned", async () => {
  vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv) =>
    argv.at(-1)?.endsWith("openclaw.mjs")
      ? { ...success, stdout: "openclaw-bin\n" }
      : { ...success, code: 1, stderr: `error: No package owns ${argv.at(-1)}\n` },
  );
  await withMockedPlatform("linux", async () => {
    await expect(assertPacmanUnowned(root)).rejects.toMatchObject({
      reason: "unmanaged-package-install",
      ownership: { packageName: "openclaw-bin" },
    });
  });
});

it.each([
  {
    name: "database error",
    result: { ...success, code: 1, stderr: "error: could not register local database\n" },
  },
  { name: "empty success", result: success },
  { name: "malformed owner", result: { ...success, stdout: "openclaw\nother\n" } },
  { name: "timeout", result: { ...success, code: null, termination: "timeout" as const } },
])("keeps $name distinct from an unowned install", async ({ result }) => {
  vi.spyOn(processExec, "runCommandWithTimeout").mockResolvedValue(result);
  await withMockedPlatform("linux", async () => {
    await expect(inspectPacmanOwnership(root)).rejects.toMatchObject({
      reason: "pacman-ownership-unavailable",
    });
  });
});

it("does not probe pacman when it is absent", async () => {
  vi.mocked(fs.access).mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
  const command = vi.spyOn(processExec, "runCommandWithTimeout");
  await withMockedPlatform("linux", async () => {
    await expect(inspectPacmanOwnership(root)).resolves.toBeNull();
  });
  expect(command).not.toHaveBeenCalled();
});

it("checks an owned file symlink without following its unrelated referent", async () => {
  const manifest = path.join(root, "package.json");
  const referent = path.join(root, "unowned.json");
  await fs.rename(manifest, referent);
  await fs.symlink(referent, manifest);
  vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv) =>
    argv.at(-1)?.endsWith("/package.json")
      ? { ...success, stdout: "openclaw\n" }
      : { ...success, code: 1, stderr: `error: No package owns ${argv.at(-1)}\n` },
  );
  await withMockedPlatform("linux", async () => {
    await expect(inspectPacmanOwnership(root)).resolves.toMatchObject({ packageName: "openclaw" });
  });
});
