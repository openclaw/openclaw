import fs from "node:fs";
import { join } from "node:path";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  requestDeferredPackageDirInstall,
  resolvePackageDirInstallTransaction,
} from "../infra/install-package-dir.js";
import { packToArchive } from "../plugins/test-helpers/archive-fixtures.js";
import { npmCommandArgs } from "../test-utils/npm-command.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";

const mocks = vi.hoisted(() => ({
  sourceScan: vi.fn(),
  dependencyScan: vi.fn(),
  run: vi.fn(),
}));
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandWithTimeout: mocks.run,
}));
vi.mock("../plugins/install-security-scan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/install-security-scan.js")>()),
  scanPackageInstallSource: mocks.sourceScan,
  scanInstalledPackageDependencyTree: mocks.dependencyScan,
}));

const { installHooksFromPath, installHooksFromNpmSpec } = await import("./install.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const packageName = "@acme/canonical-hooks";
const version = "1.0.0";
const manifest = { name: packageName, version, openclaw: { hooks: ["./hooks/one-hook"] } };
const sources = ["package", "single hook", "archive", "npm"] as const;

type Source = (typeof sources)[number];
type InstallOptions = Omit<Parameters<typeof installHooksFromPath>[0], "path" | "hooksDir">;

function makeHookInstallFixture(source: Source = "single hook") {
  const root = tempDirs.make("openclaw-hook-policy-");
  const pkgDir = join(root, "source");
  const hookDir = join(pkgDir, "hooks", "one-hook");
  const hooksDir = join(root, "hooks");
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(join(pkgDir, "package.json"), JSON.stringify(manifest));
  fs.writeFileSync(join(hookDir, "HOOK.md"), "---\nname: one-hook\n---\n");
  fs.writeFileSync(join(hookDir, "handler.ts"), "export default async () => {};\n");
  const targetDir = join(hooksDir, source === "single hook" ? "one-hook" : "canonical-hooks");
  async function install(options: InstallOptions = {}) {
    let sourcePath = source === "single hook" ? hookDir : pkgDir;
    if (source === "archive" || source === "npm") {
      sourcePath = await packToArchive({ pkgDir, outDir: root, outName: "hooks.tgz" });
    }
    if (source === "npm") {
      mocks.run.mockImplementation(async (argv, commandOptions) => {
        if (npmCommandArgs(argv)?.[0] !== "pack" || !commandOptions.cwd) {
          throw new Error("unexpected npm fixture command");
        }
        fs.copyFileSync(sourcePath, join(commandOptions.cwd, "hooks.tgz"));
        return createCommandResult({
          stdout: JSON.stringify([{ name: packageName, version, filename: "hooks.tgz" }]),
        });
      });
    }
    return source === "npm"
      ? installHooksFromNpmSpec({ ...options, hooksDir, spec: `${packageName}@${version}` })
      : installHooksFromPath({ ...options, hooksDir, path: sourcePath });
  }
  return { hookDir, targetDir, install };
}

beforeEach(() => Object.values(mocks).forEach((mock) => mock.mockReset()));

it("passes acknowledgement through both scan stages", async () => {
  const { install } = makeHookInstallFixture();
  const onInstallPolicyWarning = vi.fn().mockResolvedValue({ status: "approved" });

  await install({ onInstallPolicyWarning });

  for (const scan of [mocks.sourceScan, mocks.dependencyScan]) {
    expect(scan).toHaveBeenCalledWith(expect.objectContaining({ onInstallPolicyWarning }));
  }
});

it.each(["package", "single hook"] as const)(
  "does not publish a %s after its authority closes during staged preparation",
  async (source) => {
    const { install, targetDir } = makeHookInstallFixture(source);
    let authorityActive = true;
    mocks.dependencyScan.mockImplementationOnce(async () => {
      authorityActive = false;
    });
    const result = await install({
      beforePersistentApply: () => assert(authorityActive, "hook installation authority closed"),
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("hook installation authority closed"),
    });
    expect(mocks.dependencyScan).toHaveBeenCalledOnce();
    expect(fs.existsSync(targetDir)).toBe(false);
  },
);

it.each(
  sources.flatMap((source) => (["install", "update"] as const).map((mode) => ({ source, mode }))),
)("rolls back a deferred $source $mode payload", async ({ source, mode }) => {
  const { hookDir, targetDir, install } = makeHookInstallFixture(source);
  const previousMarker = join(targetDir, "previous.txt");
  if (mode === "update") {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(previousMarker, "previous payload");
  }
  const result = await install(requestDeferredPackageDirInstall({ mode }));
  expect(result.ok).toBe(true);
  const transaction = result.ok ? resolvePackageDirInstallTransaction(result) : undefined;
  assert(transaction, "expected deferred hook payload transaction");
  const installedHook = source === "single hook" ? targetDir : join(targetDir, "hooks", "one-hook");
  expect(fs.existsSync(join(installedHook, "handler.ts"))).toBe(true);
  await transaction.rollback();
  expect(fs.existsSync(targetDir)).toBe(mode === "update");
  if (mode === "update") {
    expect(fs.readFileSync(previousMarker, "utf8")).toBe("previous payload");
  }
  expect(fs.existsSync(join(hookDir, "handler.ts"))).toBe(true);
});
