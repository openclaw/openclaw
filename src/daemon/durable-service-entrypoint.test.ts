import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileLockOptions } from "../infra/file-lock.js";
import type { PackageUpdateTransaction } from "../infra/package-update-swap-contract.js";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "../infra/update-npm-prefix.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  installDurableServiceCli,
  resolveDurableServiceCli,
} from "./durable-service-entrypoint.js";
import { withGatewayServiceInstallationRecovery } from "./service-update-authority.js";

const { runGlobalPackageUpdateSteps, installedCopyErrors, packageLock } = vi.hoisted(() => ({
  // Validates, then reaches the activation gate the way the package updater does, then finishes.
  runGlobalPackageUpdateSteps: vi.fn(
    async (params: {
      env?: NodeJS.ProcessEnv;
      installSpec?: string;
      validateCandidate?: (packageRoot: string) => Promise<unknown>;
      beforeActivate?: () => Promise<void>;
      onTransaction?: (transaction: PackageUpdateTransaction) => void | Promise<void>;
    }) => {
      await params.validateCandidate?.("/nonexistent-candidate");
      await params.beforeActivate?.();
      return { failedStep: null };
    },
  ),
  installedCopyErrors: vi.fn(
    async (_params: { packageRoot: string; expectedVersion?: string | null }) => ["missing"],
  ),
  packageLock: { onAttempt: () => {} },
}));

// The real install env builder runs; package-manager steps and probes are recorded only.
// mock-isolation: record the npm install steps instead of running npm on the test host.
vi.mock("../infra/package-update-steps.js", () => ({ runGlobalPackageUpdateSteps }));
// mock-isolation: the fixture copy has no packed dist inventory to verify.
vi.mock("../infra/package-dist-inventory.js", () => ({
  collectPackageDistContentInventoryErrors: async () => [],
}));
// mock-isolation: no update step may spawn a process from this test.
vi.mock("../infra/update-runner-command.js", () => ({ runStep: vi.fn() }));
// mock-isolation: no command may spawn from this test.
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: vi.fn() }));
// mock-isolation: keep npm prefix and installed-copy probes off the test host.
vi.mock("../infra/update-global.js", async () => ({
  createGlobalInstallEnv: (await import("../infra/update-global-env.js")).createGlobalInstallEnv,
  // No durable copy yet, and no npm probe on the test host.
  collectInstalledGlobalPackageErrors: installedCopyErrors,
  resolveGlobalInstallTarget: async () => ({ manager: "npm", command: "npm" }),
}));

// mock-isolation: observes when an install asks for the package lock; the real lock runs.
vi.mock("../infra/file-lock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/file-lock.js")>();
  return {
    ...actual,
    withFileLock: <T>(file: string, options: FileLockOptions, fn: () => Promise<T>) => {
      packageLock.onAttempt();
      return actual.withFileLock(file, options, fn);
    },
  };
});

describe("resolveDurableServiceCli", () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "durable-cli-")));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
    runGlobalPackageUpdateSteps.mockReset();
    installedCopyErrors.mockReset();
  });
  const stateEnv = () => ({ OPENCLAW_STATE_DIR: path.join(root, "state") });
  const npxEntrypoint = (version = "1.2.3") => {
    const npxPackage = path.join(root, ".npm", "_npx", version, "node_modules", "openclaw");
    fs.mkdirSync(npxPackage, { recursive: true });
    fs.writeFileSync(
      path.join(npxPackage, "package.json"),
      JSON.stringify({ name: "openclaw", version }),
    );
    fs.writeFileSync(path.join(npxPackage, "openclaw.mjs"), "");
    fs.mkdirSync(path.join(npxPackage, "dist"), { recursive: true });
    fs.writeFileSync(path.join(npxPackage, "dist", "index.js"), "");
    return path.join(npxPackage, "openclaw.mjs");
  };
  const durableCopy = () => {
    const prefix = resolveNpmGlobalPrefixLayoutFromPrefix(path.join(root, "state", "npm"));
    const durable = path.join(prefix.globalRoot, "openclaw", "openclaw.mjs");
    fs.mkdirSync(path.dirname(durable), { recursive: true });
    fs.writeFileSync(durable, "");
    return durable;
  };

  it("does not reuse an unchecked copy while planning, and names the explicit reinstall", async () => {
    const entrypoint = npxEntrypoint();
    durableCopy();
    installedCopyErrors.mockResolvedValueOnce(["expected version 1.2.3, found 1.0.0"]);

    await expect(
      resolveDurableServiceCli(stateEnv(), { install: false, service: "gateway" }, entrypoint),
    ).rejects.toThrow(/found 1\.0\.0.*npx openclaw@1\.2\.3 gateway install --force/u);
    expect(installedCopyErrors).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: "1.2.3" }),
    );
    expect(runGlobalPackageUpdateSteps).not.toHaveBeenCalled();
  });

  it("reuses a copy that matches this version and passes the integrity checks", async () => {
    const entrypoint = npxEntrypoint();
    const durable = durableCopy();
    installedCopyErrors.mockResolvedValueOnce([]);

    await expect(
      resolveDurableServiceCli(stateEnv(), { install: false, service: "gateway" }, entrypoint),
    ).resolves.toEqual({ entrypoint: durable });
    expect(runGlobalPackageUpdateSteps).not.toHaveBeenCalled();
  });

  it("runs npm lifecycle scripts with this Node, not an older one first on PATH", async () => {
    const env = { ...stateEnv(), PATH: path.resolve("/run/current-system/sw/bin") };
    const durable = await resolveDurableServiceCli(
      env,
      { install: true, service: "gateway" },
      npxEntrypoint(),
    );
    expect(durable?.replacement).toMatchObject({ version: "1.2.3" });
    expect(runGlobalPackageUpdateSteps).not.toHaveBeenCalled();

    await installDurableServiceCli({
      env,
      replacement: durable?.replacement,
      install: async (beforeMutation) => await beforeMutation?.(),
      verify: async () => true,
      warn: vi.fn(),
    });

    const installEnv = runGlobalPackageUpdateSteps.mock.calls[0]?.[0].env;
    expect(installEnv?.PATH?.split(path.delimiter).slice(0, 2)).toEqual([
      path.dirname(process.execPath),
      env.PATH,
    ]);
  });

  // A live durable copy at 1.0.0: the package check reads its version, the fake updater swaps
  // it at the activation gate, and restore puts back what that swap displaced.
  const liveCopy = () => {
    const packageRoot = path.dirname(durableCopy());
    const manifest = path.join(packageRoot, "package.json");
    const writeVersion = (version: string) =>
      fs.writeFileSync(manifest, JSON.stringify({ name: "openclaw", version }));
    const liveVersion = (): string => JSON.parse(fs.readFileSync(manifest, "utf8")).version;
    writeVersion("1.0.0");
    installedCopyErrors.mockImplementation(async ({ expectedVersion }) =>
      liveVersion() === expectedVersion
        ? []
        : [`expected ${expectedVersion}, found ${liveVersion()}`],
    );
    runGlobalPackageUpdateSteps.mockImplementation(async (params) => {
      await params.validateCandidate?.("/nonexistent-candidate");
      await params.beforeActivate?.();
      const previous = liveVersion();
      await params.onTransaction?.({
        backupRoot: `${packageRoot}.backup`,
        rollback: async () => {
          writeVersion(previous);
          return {
            name: "package-rollback",
            command: "",
            cwd: root,
            durationMs: 0,
            exitCode: 0,
            activePackageRoot: packageRoot,
          };
        },
        complete: async () => undefined,
      });
      writeVersion(params.installSpec?.split("@")[1] ?? "");
      return { failedStep: null };
    });
    return liveVersion;
  };
  const plan = async (version: string, service: "gateway" | "node") =>
    (await resolveDurableServiceCli(stateEnv(), { install: true, service }, npxEntrypoint(version)))
      ?.replacement;

  // The Gateway install swaps in 2.0.0 and then fails, while a node install for `nodeVersion`
  // arrives; the node install is planned only after the Gateway's swap is live.
  async function raceFailedGatewayInstall(nodeVersion: string) {
    const gatewaySwapped = createDeferredCore();
    const gatewayFails = createDeferredCore();
    const nodeAskedForLock = createDeferredCore();
    const gateway = installDurableServiceCli({
      env: stateEnv(),
      replacement: await plan("2.0.0", "gateway"),
      // Native recovery settles: it stops the replacement and calls the hook before restarting.
      install: async (beforeMutation, beforeRecovery) => {
        await beforeMutation?.();
        gatewaySwapped.resolve();
        await gatewayFails.promise;
        await beforeRecovery?.();
        throw new Error("gateway install failed");
      },
      verify: async () => true,
      warn: vi.fn(),
    });
    await gatewaySwapped.promise;
    packageLock.onAttempt = () => nodeAskedForLock.resolve();
    const node = installDurableServiceCli({
      env: stateEnv(),
      replacement: await plan(nodeVersion, "node"),
      install: async (beforeMutation) => await beforeMutation?.(),
      verify: async () => true,
      warn: vi.fn(),
    });
    // Without the package lock the node install finishes here, before the Gateway fails.
    await Promise.race([nodeAskedForLock.promise, node]);
    gatewayFails.resolve();
    try {
      await expect(gateway).rejects.toThrow("gateway install failed");
      await node;
    } finally {
      packageLock.onAttempt = () => {};
      runGlobalPackageUpdateSteps.mockReset();
      installedCopyErrors.mockReset();
    }
  }

  it.each([
    ["swaps in its own version", "3.0.0"],
    ["reuses the version the Gateway swapped in", "2.0.0"],
  ])(
    "keeps a failed Gateway install's restore from undoing a node install that %s",
    async (_name, nodeVersion) => {
      const liveVersion = liveCopy();

      await raceFailedGatewayInstall(nodeVersion);

      expect(liveVersion()).toBe(nodeVersion);
    },
  );

  it.each([
    ["restores the previous copy when native recovery settles", "settled", "1.0.0"],
    ["keeps the new copy when the restart's process cleanup is uncertain", "cleanup", "2.0.0"],
    ["keeps the new copy when readback fails after a successful install", "readback", "2.0.0"],
  ] as const)("%s", async (_name, failure, expected) => {
    const liveVersion = liveCopy();
    let restartedOn: string | undefined;
    const warn = vi.fn();

    await expect(
      installDurableServiceCli({
        env: stateEnv(),
        replacement: await plan("2.0.0", "gateway"),
        install: async (beforeMutation, beforeRecovery) => {
          // The real recovery wrapper; its restore stands in for a platform recovery that stops
          // the replacement, calls the hook, then restarts the previous service.
          await withGatewayServiceInstallationRecovery(
            async () => {
              await beforeMutation?.();
              if (failure === "settled") {
                throw new Error("activation failed");
              }
              if (failure === "cleanup") {
                throw new CommandProcessCleanupError();
              }
            },
            async () => {
              await beforeRecovery?.();
              restartedOn = liveVersion();
              return true;
            },
          );
          // The service's definition readback or runtime-pin commit after a native install.
          throw new Error("SQLITE_FULL: database or disk is full");
        },
        verify: async () => true,
        warn,
      }),
    ).rejects.toThrow();
    expect(liveVersion()).toBe(expected);
    if (failure === "settled") {
      expect(restartedOn).toBe("1.0.0");
    } else {
      expect(restartedOn).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("without a settled service recovery"),
      );
    }
  });
});
