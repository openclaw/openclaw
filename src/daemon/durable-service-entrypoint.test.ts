import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileLockOptions } from "../infra/file-lock.js";
import type { PackageUpdateTransaction } from "../infra/package-update-swap-contract.js";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "../infra/update-npm-prefix.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  installDurableServiceCli,
  resolveDurableServiceCli,
} from "./durable-service-entrypoint.js";

const { runGlobalPackageUpdateSteps, installedCopyErrors, packageLock } = vi.hoisted(() => ({
  // Reaches the activation gate the way the package updater does, then finishes.
  runGlobalPackageUpdateSteps: vi.fn(
    async (params: {
      env?: NodeJS.ProcessEnv;
      installSpec?: string;
      beforeActivate?: () => Promise<void>;
      onTransaction?: (transaction: PackageUpdateTransaction) => void | Promise<void>;
    }) => {
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
    fs.mkdirSync(path.join(npxPackage, "dist"));
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
      resolveDurableServiceCli(stateEnv(), { install: true, service: "gateway" }, entrypoint),
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

  it("keeps a failed install's restore from undoing another install's swap of the shared copy", async () => {
    const env = stateEnv();
    const packageRoot = path.dirname(durableCopy());
    const manifest = path.join(packageRoot, "package.json");
    const writeVersion = (version: string) =>
      fs.writeFileSync(manifest, JSON.stringify({ name: "openclaw", version }));
    const liveVersion = () => JSON.parse(fs.readFileSync(manifest, "utf8")).version;
    writeVersion("1.0.0");
    // Swaps the live copy at the activation gate; restore puts back what that swap displaced.
    runGlobalPackageUpdateSteps.mockImplementation(async (params) => {
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
    const plan = async (version: string, service: "gateway" | "node") =>
      (await resolveDurableServiceCli(env, { install: true, service }, npxEntrypoint(version)))
        ?.replacement;
    const gatewaySwapped = createDeferredCore();
    const gatewayFails = createDeferredCore();
    const nodeAskedForLock = createDeferredCore();

    // The Gateway install swaps in 2.0.0, then fails while a node install arrives with 3.0.0.
    const gateway = installDurableServiceCli({
      env,
      replacement: await plan("2.0.0", "gateway"),
      install: async (beforeMutation) => {
        await beforeMutation?.();
        gatewaySwapped.resolve();
        await gatewayFails.promise;
        throw new Error("gateway install failed");
      },
      verify: async () => true,
      warn: vi.fn(),
    });
    await gatewaySwapped.promise;
    packageLock.onAttempt = () => nodeAskedForLock.resolve();
    const node = installDurableServiceCli({
      env,
      replacement: await plan("3.0.0", "node"),
      install: async (beforeMutation) => await beforeMutation?.(),
      verify: async () => true,
      warn: vi.fn(),
    });
    // Without a shared package lock the node install finishes here, before the failure.
    await Promise.race([nodeAskedForLock.promise, node]);
    gatewayFails.resolve();

    await expect(gateway).rejects.toThrow("gateway install failed");
    await node;
    expect(liveVersion()).toBe("3.0.0");
    packageLock.onAttempt = () => {};
    runGlobalPackageUpdateSteps.mockReset();
  });
});
