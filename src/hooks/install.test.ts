import fs from "node:fs";
import path from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  requestDeferredPackageDirInstall,
  resolvePackageDirInstallTransaction,
} from "../infra/install-package-dir.js";
import { packToArchive } from "../plugins/test-helpers/archive-fixtures.js";
import { npmCommandArgs } from "../test-utils/npm-command.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { writeHookFixture } from "./hook-fixture.test-support.js";
import { createZipHookPackBuffer } from "./install-archive.test-support.js";

type InstallHooksFromPath = typeof import("./install.js").installHooksFromPath;

const commandSuccess = createCommandResult();
const runCommand = vi.fn();
const scanSource = vi.fn();
const scanInstalled = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommand(...args),
}));

vi.mock("../plugins/install-security-scan.js", () => ({
  scanPackageInstallSource: (...args: unknown[]) => scanSource(...args),
  scanInstalledPackageDependencyTree: (...args: unknown[]) => scanInstalled(...args),
}));

vi.resetModules();

const { HOOK_INSTALL_ERROR_CODE, installHooksFromNpmSpec, installHooksFromPath } =
  await import("./install.js");
const hookInstallRuntime = await import("./install.runtime.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const makeTempDir = () => tempDirs.make("openclaw-hook-install-");

const fixturesDir = path.resolve(process.cwd(), "test", "fixtures", "hooks-install");
const zipHooksBuffer = await createZipHookPackBuffer({
  packageName: "@openclaw/zip-hooks",
  hookName: "zip-hook",
  hookDescription: "Zip hook",
  heading: "Zip Hook",
});
const tarEvilIdBuffer = fs.readFileSync(path.join(fixturesDir, "tar-evil-id.tar"));

function writeJson(dir: string, value: unknown) {
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(value));
}

beforeEach(() => {
  runCommand.mockReset();
  scanSource.mockReset();
  scanSource.mockResolvedValue(undefined);
  scanInstalled.mockReset();
  scanInstalled.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

function writeArchiveFixture(fileName: string, contents: Buffer) {
  const stateDir = makeTempDir();
  const archivePath = path.join(stateDir, fileName);
  fs.writeFileSync(archivePath, contents);
  return { stateDir, archivePath, hooksDir: path.join(stateDir, "hooks") };
}

function expectFailure(result: Awaited<ReturnType<InstallHooksFromPath>>, snippet: string) {
  assert(!result.ok, "expected install failure");
  expect(result.error).toContain(snippet);
}

function writeHookPackManifest(params: {
  pkgDir: string;
  hooks: string[];
  packageName?: string;
  dependencies?: Record<string, string>;
  extensions?: string[];
}) {
  writeJson(params.pkgDir, {
    name: params.packageName ?? "@openclaw/test-hooks",
    version: "0.0.1",
    openclaw: {
      hooks: params.hooks,
      ...(params.extensions ? { extensions: params.extensions } : {}),
    },
    ...(params.dependencies ? { dependencies: params.dependencies } : {}),
  });
}

it("rejects hook packs with traversal-like ids", async () => {
  const { archivePath, hooksDir } = writeArchiveFixture("hooks.tar", tarEvilIdBuffer);
  const result = await installHooksFromPath({ path: archivePath, hooksDir });
  expectFailure(result, "reserved path segment");
});

function makePackage(packageName = "@acme/canonical-hooks", dependencies?: Record<string, string>) {
  const pkgDir = makeTempDir();
  const hooksDir = path.join(makeTempDir(), "hooks");
  writeHookPackManifest({ pkgDir, packageName, dependencies, hooks: ["./hooks/one-hook"] });
  writeHookFixture(
    path.join(pkgDir, "hooks", "one-hook"),
    '---\nname: one-hook\ndescription: One hook\nmetadata: {"openclaw":{"events":["command:new"]}}\n---\n\n# One Hook',
  );
  return { pkgDir, hooksDir };
}

function writeBareHook(hookDir: string, name = "my-hook") {
  writeHookFixture(hookDir, `---\nname: ${name}\n---\n`);
}

const sources = ["package", "single hook", "archive", "npm"] as const;
async function deferredFixture(source: (typeof sources)[number]) {
  const { pkgDir, hooksDir } = makePackage();
  const hookDir = path.join(pkgDir, "hooks", "one-hook");
  let sourcePath = source === "single hook" ? hookDir : pkgDir;
  if (source === "archive" || source === "npm") {
    sourcePath = await packToArchive({ pkgDir, outDir: makeTempDir(), outName: "hooks.tgz" });
  }
  if (source === "npm") {
    runCommand.mockImplementation(async (argv, options) => {
      if (npmCommandArgs(argv)?.[0] !== "pack" || !options.cwd) {
        throw new Error("unexpected npm fixture command");
      }
      fs.copyFileSync(sourcePath, path.join(options.cwd, "hooks.tgz"));
      return createCommandResult({
        stdout: JSON.stringify([
          {
            name: "@acme/canonical-hooks",
            version: "0.0.1",
            filename: "hooks.tgz",
            integrity: "sha512-hook-test",
            shasum: "hookshasum",
          },
        ]),
      });
    });
  }
  return {
    hookDir,
    targetDir: path.join(hooksDir, source === "single hook" ? "one-hook" : "canonical-hooks"),
    install: (options: Omit<Parameters<InstallHooksFromPath>[0], "path" | "hooksDir"> = {}) =>
      source === "npm"
        ? installHooksFromNpmSpec({ ...options, hooksDir, spec: "@acme/canonical-hooks@0.0.1" })
        : installHooksFromPath({ ...options, hooksDir, path: sourcePath }),
  };
}

it("passes acknowledgement through both scan stages", async () => {
  const { install } = await deferredFixture("single hook");
  const onInstallPolicyWarning = vi.fn().mockResolvedValue({ status: "approved" });
  await install({ onInstallPolicyWarning });
  for (const scan of [scanSource, scanInstalled]) {
    expect(scan).toHaveBeenCalledWith(expect.objectContaining({ onInstallPolicyWarning }));
  }
});

it.each(["package", "single hook"] as const)(
  "does not publish a %s after its authority closes during staged preparation",
  async (source) => {
    const { install, targetDir } = await deferredFixture(source);
    let authorityActive = true;
    scanInstalled.mockImplementationOnce(async () => {
      authorityActive = false;
    });
    expect(
      await install({
        beforePersistentApply: () => assert(authorityActive, "hook installation authority closed"),
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("hook installation authority closed"),
    });
    expect(scanInstalled).toHaveBeenCalledOnce();
    expect(fs.existsSync(targetDir)).toBe(false);
  },
);

it.each(
  sources.flatMap((source) => (["install", "update"] as const).map((mode) => ({ source, mode }))),
)("rolls back a deferred $source $mode payload", async ({ source, mode }) => {
  const { hookDir, targetDir, install } = await deferredFixture(source);
  const previousMarker = path.join(targetDir, "previous.txt");
  if (mode === "update") {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(previousMarker, "previous payload");
  }
  const result = await install(requestDeferredPackageDirInstall({ mode }));
  expect(result.ok).toBe(true);
  const transaction = result.ok ? resolvePackageDirInstallTransaction(result) : undefined;
  assert(transaction, "expected deferred hook payload transaction");
  const installedHook =
    source === "single hook" ? targetDir : path.join(targetDir, "hooks", "one-hook");
  expect(fs.existsSync(path.join(installedHook, "handler.ts"))).toBe(true);
  await transaction.rollback();
  expect(fs.existsSync(targetDir)).toBe(mode === "update");
  if (mode === "update") {
    expect(fs.readFileSync(previousMarker, "utf8")).toBe("previous payload");
  }
  expect(fs.existsSync(path.join(hookDir, "handler.ts"))).toBe(true);
});

describe("installHooksFromPath", () => {
  it.each([
    {
      openclaw: {},
      error: "package.json missing openclaw.hooks",
      code: HOOK_INSTALL_ERROR_CODE.MISSING_OPENCLAW_HOOKS,
    },
    {
      openclaw: { hooks: [] },
      error: "package.json openclaw.hooks is empty",
      code: HOOK_INSTALL_ERROR_CODE.EMPTY_OPENCLAW_HOOKS,
    },
  ])("returns a stable code for $error", async ({ openclaw, error, code }) => {
    const pkgDir = makeTempDir();
    writeJson(pkgDir, { name: "@openclaw/test-hooks", openclaw });

    const result = await installHooksFromPath({ path: pkgDir, hooksDir: makeTempDir() });

    expect(result).toEqual({ ok: false, error, code });
  });

  it("validates hook-name uniqueness before package inspection side effects", async () => {
    const pkgDir = makeTempDir();
    const hooksDir = path.join(makeTempDir(), "managed-hooks");
    writeHookPackManifest({ pkgDir, hooks: ["./hooks/0", "./hooks/1"] });
    for (const index of [0, 1]) {
      writeBareHook(path.join(pkgDir, "hooks", String(index)), "shared-hook");
    }
    const targetAvailability = vi.spyOn(hookInstallRuntime, "ensureInstallTargetAvailable");

    const result = await installHooksFromPath({
      path: pkgDir,
      hooksDir,
      inspection: "package-kind",
    });
    expect(result).toEqual({
      ok: false,
      error: 'duplicate hook name "shared-hook" in hook package',
    });
    expect(targetAvailability).not.toHaveBeenCalled();
    expect(scanSource).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
    expect(fs.existsSync(hooksDir)).toBe(false);
  });

  it("preserves the declared OpenClaw dependency during update", async () => {
    const { pkgDir, hooksDir } = makePackage("@openclaw/test-hooks", { openclaw: ">=2026.4.5" });
    fs.mkdirSync(path.join(hooksDir, "test-hooks"), { recursive: true });
    runCommand.mockImplementation(async (_argv, optionsOrTimeout) => {
      const cwd = typeof optionsOrTimeout === "number" ? undefined : optionsOrTimeout.cwd;
      if (!cwd) {
        throw new Error("expected staged hook install cwd");
      }
      const manifest = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
      expect(manifest.dependencies?.openclaw).toBe(">=2026.4.5");
      return commandSuccess;
    });

    const result = await installHooksFromPath({ path: pkgDir, hooksDir, mode: "update" });

    expect(result.ok).toBe(true);
    expect(runCommand).toHaveBeenCalled();
  });

  it.each([
    { name: "single hook", pluginId: "my-hook", error: "blocked staged hook", dependencies: false },
    {
      name: "materialized dependencies",
      pluginId: "canonical-hooks",
      error: "blocked materialized dependency tree",
      dependencies: true,
    },
  ])("blocks $name before publishing the target", async ({ pluginId, error, dependencies }) => {
    const fixture = dependencies
      ? makePackage("@acme/canonical-hooks", { "blocked-transitive": "1.0.0" })
      : {
          pkgDir: path.join(makeTempDir(), "my-hook"),
          hooksDir: path.join(makeTempDir(), "hooks"),
        };
    if (dependencies) {
      runCommand.mockResolvedValue(commandSuccess);
    } else {
      writeBareHook(fixture.pkgDir);
    }
    scanInstalled.mockResolvedValue({
      blocked: { code: "security_scan_blocked", reason: error },
    });
    const result = await installHooksFromPath({ path: fixture.pkgDir, hooksDir: fixture.hooksDir });
    expect(result).toEqual({ ok: false, code: "security_scan_blocked", error });
    expect(scanInstalled).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "install",
        pluginId,
        requestKind: "plugin-dir",
      }),
    );
    expect(scanInstalled.mock.calls[0]?.[0]?.packageDir).toContain(".openclaw-install-stage-");
    expect(fs.existsSync(path.join(fixture.hooksDir, pluginId))).toBe(false);
  });

  it.each([
    { kind: "oversized", error: /File exceeds 1048576 bytes/ },
    ...(process.platform === "win32"
      ? []
      : [{ kind: "symlinked", error: /path must be a regular file/ }]),
  ])("rejects a $kind HOOK.md", async ({ kind, error }) => {
    const hookDir = path.join(makeTempDir(), "my-hook");
    writeBareHook(hookDir);
    const descriptor = path.join(hookDir, "HOOK.md");
    if (kind === "oversized") {
      fs.writeFileSync(descriptor, "x".repeat(1024 * 1024 + 1));
    } else {
      const external = path.join(makeTempDir(), "external-HOOK.md");
      fs.renameSync(descriptor, external);
      fs.symlinkSync(external, descriptor, "file");
    }
    await expect(installHooksFromPath({ path: hookDir, hooksDir: makeTempDir() })).rejects.toThrow(
      error,
    );
  });

  it.each(["extensions", "bundle marker"])(
    "classifies packages with %s as plugin-capable",
    async (kind) => {
      const { pkgDir, hooksDir } = makePackage("@openclaw/test-hooks");
      if (kind === "extensions") {
        writeHookPackManifest({
          pkgDir,
          hooks: ["./hooks/one-hook"],
          extensions: ["./dist/index.js"],
        });
      } else {
        fs.writeFileSync(path.join(pkgDir, "hooks/hooks.json"), "{}\n", "utf8");
      }
      expect(await installHooksFromPath({ path: pkgDir, hooksDir, dryRun: true })).toMatchObject({
        ok: true,
        packageKind: "plugin-capable",
      });
      if (kind === "bundle marker") {
        const rejected = await installHooksFromPath({
          path: pkgDir,
          hooksDir,
          expectedPackageKind: "hook-only",
        });
        expectFailure(rejected, "hook package kind mismatch");
        expect(fs.existsSync(path.join(hooksDir, "test-hooks"))).toBe(false);
      }
    },
  );

  it("enforces install policy with the validated hook identity before local install side effects", async () => {
    const { pkgDir, hooksDir } = makePackage();
    scanSource.mockResolvedValue({
      blocked: { code: "security_scan_blocked", reason: "blocked by operator install policy" },
    });

    const result = await installHooksFromPath({
      path: pkgDir,
      hooksDir,
      config: { security: { installPolicy: { enabled: true } } },
      mode: "update",
    });

    expect(result).toEqual({
      ok: false,
      code: "security_scan_blocked",
      error: "blocked by operator install policy",
    });
    expect(scanSource).toHaveBeenCalledWith(
      expect.objectContaining({
        packageDir: pkgDir,
        pluginId: "canonical-hooks",
        packageName: "@acme/canonical-hooks",
        version: "0.0.1",
        extensions: ["./hooks/one-hook"],
        mode: "install",
        requestKind: "plugin-dir",
        requestedSpecifier: pkgDir,
        source: { kind: "local-path", authority: "user", mutable: true, network: false },
      }),
    );
    expect(fs.existsSync(path.join(hooksDir, "canonical-hooks"))).toBe(false);
  });

  it("inspects hook package kind without running install policy or target availability checks", async () => {
    const { pkgDir, hooksDir } = makePackage();
    const ensureInstallTargetAvailableSpy = vi.spyOn(
      hookInstallRuntime,
      "ensureInstallTargetAvailable",
    );

    const result = await installHooksFromPath({
      path: pkgDir,
      hooksDir,
      inspection: "package-kind",
    });
    expect(result).toMatchObject({ ok: true, packageKind: "hook-only" });
    expect(scanSource).not.toHaveBeenCalled();
    expect(ensureInstallTargetAvailableSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(hooksDir)).toBe(false);
  });

  it("enforces archive install policy against the validated extracted hook package", async () => {
    const { stateDir, archivePath } = writeArchiveFixture("policy-hooks.zip", zipHooksBuffer);
    let scannedExtractedPackage = false;
    scanSource.mockImplementation(async (params: { packageDir: string }) => {
      scannedExtractedPackage =
        params.packageDir !== archivePath &&
        fs.existsSync(path.join(params.packageDir, "package.json"));
      return {
        blocked: { code: "security_scan_blocked", reason: "blocked extracted hook package" },
      };
    });

    const hooksDir = path.join(stateDir, "hooks");
    const result = await installHooksFromPath({ path: archivePath, hooksDir });

    expect(result).toEqual({
      ok: false,
      code: "security_scan_blocked",
      error: "blocked extracted hook package",
    });
    expect(scannedExtractedPackage).toBe(true);
    expect(scanSource).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "zip-hooks",
        requestKind: "plugin-archive",
        requestedSpecifier: archivePath,
        source: { kind: "archive", authority: "user", mutable: true, network: false },
      }),
    );
    expect(fs.existsSync(path.join(hooksDir, "zip-hooks"))).toBe(false);
  });

  it("fails closed when hook install policy evaluation throws", async () => {
    const { pkgDir, hooksDir } = makePackage();
    scanSource.mockRejectedValue(new Error("policy runner unavailable"));

    const result = await installHooksFromPath({ path: pkgDir, hooksDir });

    expect(result).toMatchObject({
      ok: false,
      code: "security_scan_failed",
      error: expect.stringContaining("policy runner unavailable"),
    });
  });

  it("rejects out-of-package hook entries", async () => {
    const cases = [
      {
        hooks: ["../outside"],
        setupLink: false,
        expected: "openclaw.hooks entry escapes package directory",
      },
      {
        hooks: ["./linked"],
        setupLink: true,
        expected: "openclaw.hooks entry resolves outside package directory",
      },
    ] as const;

    for (const testCase of cases) {
      const stateDir = makeTempDir();
      const workDir = makeTempDir();
      const pkgDir = path.join(workDir, "package");
      const outsideHookDir = path.join(workDir, "outside");
      const linkedDir = path.join(pkgDir, "linked");
      fs.mkdirSync(pkgDir, { recursive: true });
      writeBareHook(outsideHookDir, "outside");
      if (testCase.setupLink) {
        try {
          fs.symlinkSync(
            outsideHookDir,
            linkedDir,
            process.platform === "win32" ? "junction" : "dir",
          );
        } catch {
          continue;
        }
      }
      writeHookPackManifest({ pkgDir, hooks: [...testCase.hooks] });

      const result = await installHooksFromPath({
        path: pkgDir,
        hooksDir: path.join(stateDir, "hooks"),
      });

      expectFailure(result, testCase.expected);
    }
  });
});

it("installs an npm hook archive with its identity and resolution metadata", async () => {
  const { install } = await deferredFixture("npm");
  const result = await install();
  assert(result.ok, "expected npm hook installation to succeed");
  expect(result).toMatchObject({
    hookPackId: "canonical-hooks",
    packageKind: "hook-only",
    npmResolution: {
      resolvedSpec: "@acme/canonical-hooks@0.0.1",
      integrity: "sha512-hook-test",
    },
  });
  expect(fs.existsSync(path.join(result.targetDir, "hooks", "one-hook", "HOOK.md"))).toBe(true);
});
