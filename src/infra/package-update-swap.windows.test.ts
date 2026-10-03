import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as packageFilesystem from "./package-update-filesystem.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import * as retry from "./retry.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const runRetry = retry.retryAsync;
const backupPackageRoot = packageFilesystem.backupNpmPackageRoot;
let backupPlatform: NodeJS.Platform;
let wait: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;
beforeEach(() => {
  backupPlatform = "win32";
  // Select only the rename policy; fs-safe must retain the host's native platform.
  vi.spyOn(packageFilesystem, "backupNpmPackageRoot").mockImplementation(
    (source, destination, assertCurrent, warnings) =>
      backupPackageRoot(source, destination, assertCurrent, warnings, backupPlatform),
  );
  wait = vi.fn(async (_ms: number) => {});
  // Keep the real retry policy; only replace its waiting clock.
  vi.spyOn(retry, "retryAsync").mockImplementation((fn, options) =>
    runRetry(fn, { ...(typeof options === "object" ? options : {}), sleep: wait }),
  );
});
afterEach(() => vi.restoreAllMocks());

it.each(["EPERM", "EACCES", "EBUSY"])(
  "activates the Windows package after a transient %s backup rename failure",
  async (code) => {
    const { params, packageRoot, launcher } = await createPackageSwapFixture(
      dirs.make("openclaw-swap-windows-"),
    );
    const rename = fs.rename.bind(fs);
    let attempts = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from) === packageRoot && ++attempts <= 2) {
        throw Object.assign(new Error(`${code}: package is in use`), { code });
      }
      return rename(from, to);
    });
    const result = await swapStagedPackageInstall(params);
    expect(result).toMatchObject({ status: "committed", step: { exitCode: 0 } });
    expect(attempts).toBe(3);
    expect(result.step.warnings).toEqual([
      expect.stringContaining(`${code}: package is in use`),
      expect.stringContaining(`${code}: package is in use`),
    ]);
    await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
      '"version":"2.0.0"',
    );
    await expect(fs.readFile(launcher, "utf8")).resolves.toBe("candidate launcher\n");
  },
);

async function expectPersistentRenameFailure(
  platform: NodeJS.Platform,
  code: string,
  retries: boolean,
) {
  backupPlatform = platform;
  const { params, packageRoot, launcher } = await createPackageSwapFixture(
    dirs.make("openclaw-swap-locked-"),
  );
  const rename = fs.rename.bind(fs);
  let attempts = 0;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(from) === packageRoot) {
      attempts++;
      throw Object.assign(new Error(`${code}: package is in use`), { code });
    }
    return rename(from, to);
  });
  const result = await swapStagedPackageInstall(params);
  expect(result).toMatchObject({
    status: "failed",
    activePackageRoot: packageRoot,
    packageRollbackVerified: true,
    step: { exitCode: 1, failureFacts: [expect.objectContaining({ code })] },
  });
  if (retries) {
    expect(attempts).toBe(16);
    expect(result.step.warnings).toHaveLength(attempts - 1);
    expect(result.step.stderrTail).toContain(packageRoot);
    expect(result.step.stderrTail).toContain("after 16 attempts");
    expect(wait.mock.calls.reduce((total, [ms]) => total + ms, 0)).toBe(57_750);
  } else {
    expect(attempts).toBe(1);
    expect(wait).not.toHaveBeenCalled();
    expect(result.step.warnings).toBeUndefined();
  }
  await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
    '"version":"1.0.0"',
  );
  await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
}

it.each([
  { platform: "win32", code: "EPERM", retries: true },
  { platform: "win32", code: "EBUSY", retries: true },
  { platform: "win32", code: "EACCES", retries: true },
  { platform: "win32", code: "EXDEV", retries: false },
] as const)(
  "preserves the package after persistent $code on $platform (retries=$retries)",
  ({ platform, code, retries }) => expectPersistentRenameFailure(platform, code, retries),
);

it.skipIf(process.platform === "win32")(
  "preserves the package without retries after a persistent POSIX EPERM",
  () => expectPersistentRenameFailure(process.platform, "EPERM", false),
);

it.each(["authority", "source", "destination"])(
  "does not retry a Windows backup mutation after %s changes during backoff",
  async (changed) => {
    const { params, packageRoot } = await createPackageSwapFixture(
      dirs.make("openclaw-swap-revalidate-"),
    );
    let revoked = false;
    let attempts = 0;
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from) === packageRoot) {
        attempts++;
        wait.mockImplementationOnce(async () => {
          if (changed === "authority") {
            revoked = true;
          } else if (changed === "source") {
            await rename(packageRoot, `${packageRoot}.retained`);
            await fs.mkdir(packageRoot);
            await fs.writeFile(path.join(packageRoot, "replacement"), "keep");
          } else {
            await fs.mkdir(to);
            await fs.writeFile(path.join(String(to), "replacement"), "keep");
          }
        });
        throw Object.assign(new Error("package is in use"), { code: "EPERM" });
      }
      return rename(from, to);
    });
    const result = await swapStagedPackageInstall({
      ...params,
      assertCurrent: () => {
        if (revoked) {
          throw Object.assign(new Error("update owner revoked"), { code: "EPERM" });
        }
      },
    });
    expect(result.status).toBe("failed");
    expect(attempts).toBe(1);
    expect(result.step.stderrTail).toContain(
      changed === "authority" ? "update owner revoked" : "package path changed",
    );
  },
);
