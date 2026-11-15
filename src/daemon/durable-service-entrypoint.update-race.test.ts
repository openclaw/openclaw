import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNpmTarget, writePackageRoot } from "../infra/package-update-steps.test-support.js";
import {
  PackageUpdateActivationError,
  type PackageUpdateTransaction,
} from "../infra/package-update-swap-contract.js";
import { swapStagedPackageInstall } from "../infra/package-update-swap.js";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "../infra/update-npm-prefix.js";
import { installDurableServiceCli } from "./durable-service-entrypoint.js";

const { runGlobalPackageUpdateSteps, duringBackupVerification, failLauncherCopy } = vi.hoisted(
  () => ({
    runGlobalPackageUpdateSteps: vi.fn(),
    duringBackupVerification: { run: undefined as (() => Promise<void>) | undefined },
    failLauncherCopy: { run: undefined as (() => Promise<void>) | undefined },
  }),
);

// The real package swap and its rollback still run against the durable copy on disk.
// mock-isolation: npm staging is replaced by a prepared stage.
vi.mock("../infra/package-update-steps.js", () => ({ runGlobalPackageUpdateSteps }));
// mock-isolation: the real backup verification runs; this only lets a competing update publish
// while a rollback awaits it, after any earlier identity check and before the rollback's renames.
vi.mock("../infra/package-update-npm-root.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/package-update-npm-root.js")>();
  return {
    ...actual,
    verifyRetainedNpmRootRecovery: async (
      ...args: Parameters<typeof actual.verifyRetainedNpmRootRecovery>
    ) => {
      const competing = duringBackupVerification.run;
      duringBackupVerification.run = undefined;
      await competing?.();
      return actual.verifyRetainedNpmRootRecovery(...args);
    },
  };
});
// mock-isolation: the real copy runs except once, when a test fails the install's launcher copy
// after its package was published, optionally after a competing update publishes first.
vi.mock("../infra/package-update-filesystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/package-update-filesystem.js")>();
  return {
    ...actual,
    copyPackagePathEntry: async (...args: Parameters<typeof actual.copyPackagePathEntry>) => {
      const failing = failLauncherCopy.run;
      if (!failing) {
        return actual.copyPackagePathEntry(...args);
      }
      failLauncherCopy.run = undefined;
      await failing();
      throw new Error("launcher copy failed");
    },
  };
});
// mock-isolation: no npm prefix probe may spawn on the test host.
vi.mock("../infra/update-global.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-global.js")>()),
  resolveGlobalInstallTarget: async () => ({ manager: "npm", command: "npm" }),
}));

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "durable-update-race-")));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  runGlobalPackageUpdateSteps.mockReset();
  duringBackupVerification.run = undefined;
  failLauncherCopy.run = undefined;
});

const env = () => ({ OPENCLAW_STATE_DIR: path.join(root, "state") });
const durable = () => resolveNpmGlobalPrefixLayoutFromPrefix(path.join(root, "state", "npm"));
const packageRoot = () => path.join(durable().globalRoot, "openclaw");
const liveVersion = () =>
  JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8")).version;

/** An npm prefix holding `version`, staged the way npm leaves a candidate. */
async function stage(name: string, version: string) {
  const prefix = path.join(root, name);
  const layout = resolveNpmGlobalPrefixLayoutFromPrefix(prefix);
  const stagedRoot = path.join(layout.globalRoot, "openclaw");
  await writePackageRoot(stagedRoot, version);
  fs.mkdirSync(layout.binDir, { recursive: true });
  fs.writeFileSync(path.join(layout.binDir, "openclaw"), `launcher ${version}\n`);
  return {
    prefix,
    layout,
    packageRoot: stagedRoot,
    installTarget: createNpmTarget(layout.globalRoot),
  };
}

/**
 * The real package swap of `openclaw update` and of a service install, into the durable copy.
 * A service install's updater validates the staged candidate first, as the package updater does.
 */
async function publish(
  name: string,
  version: string,
  updater: {
    validateCandidate?: (packageRoot: string) => Promise<Array<{ exitCode: number | null }>>;
    beforeActivate?: () => Promise<void>;
    onTransaction?: (transaction: PackageUpdateTransaction) => void | Promise<void>;
  } = {},
  options: { mayFail?: boolean } = {},
) {
  const staged = await stage(name, version);
  const validation = (await updater.validateCandidate?.(staged.packageRoot)) ?? [];
  expect(validation.filter((step) => step.exitCode !== 0)).toEqual([]);
  const result = await swapStagedPackageInstall({
    installTarget: createNpmTarget(durable().globalRoot),
    packageName: "openclaw",
    stage: staged,
    ...(updater.beforeActivate ? { beforeActivate: updater.beforeActivate } : {}),
    ...(updater.onTransaction ? { onTransaction: updater.onTransaction } : {}),
  });
  if (!options.mayFail) {
    expect(result.status, result.step.stderrTail ?? "").toBe("committed");
  }
  return result;
}

it.each([
  ["restores the previous copy when no update intervenes", "none", "1.0.0"],
  ["keeps an update published before the restore starts", "before-restore", "3.0.0"],
  [
    "keeps an update published while the restore verifies its backup",
    "during-backup-verification",
    "3.0.0",
  ],
  [
    "keeps an update published while its own updater cleans up after publishing",
    "after-publication",
    "3.0.0",
  ],
  ["keeps its partly published copy after its launcher copy fails", "launcher-copy-fails", "2.0.0"],
  [
    "keeps an update published before its failed launcher copy",
    "update-then-launcher-copy-fails",
    "3.0.0",
  ],
] as const)("a failed install %s", async (_name, when, expected) => {
  await writePackageRoot(packageRoot(), "1.0.0");
  fs.mkdirSync(durable().binDir, { recursive: true });
  fs.writeFileSync(path.join(durable().binDir, "openclaw"), "launcher 1.0.0\n");
  runGlobalPackageUpdateSteps.mockImplementation(async (params: Parameters<typeof publish>[2]) => {
    if (when === "launcher-copy-fails") {
      failLauncherCopy.run = async () => {};
    } else if (when === "update-then-launcher-copy-fails") {
      failLauncherCopy.run = async () => {
        await publish("update-stage", "3.0.0");
      };
    }
    const result = await publish("install-stage", "2.0.0", params, { mayFail: true });
    if (when === "after-publication") {
      // The updater still awaits its stage cleanup after publishing this install's copy.
      await publish("update-stage", "3.0.0");
    }
    return { failedStep: result.status === "committed" ? null : result.step };
  });
  const warn = vi.fn();

  // A node install publishes 2.0.0 and its activation fails; `openclaw update` publishes 3.0.0
  // while the install's updater finishes, before the restore starts, or while the rollback
  // verifies its backup.
  await expect(
    installDurableServiceCli({
      env: env(),
      replacement: {
        version: "2.0.0",
        globalRoot: durable().globalRoot,
        packageRoot: packageRoot(),
        entrypoint: path.join(packageRoot(), "dist", "index.js"),
      },
      // A launcher-copy failure stops in beforeMutation; otherwise native activation fails and
      // native recovery settles, calling the hook before it restarts the previous service.
      install: async (beforeMutation, beforeRecovery) => {
        await beforeMutation?.();
        expect(liveVersion()).toBe(when === "after-publication" ? "3.0.0" : "2.0.0");
        const update = async () => {
          await publish("update-stage", "3.0.0");
        };
        if (when === "before-restore") {
          await update();
        } else if (when === "during-backup-verification") {
          duringBackupVerification.run = update;
        }
        await beforeRecovery?.();
        throw new Error("node activation failed");
      },
      verify: async () => true,
      warn,
    }),
  ).rejects.toThrow(
    when.includes("launcher-copy-fails")
      ? "Cannot install durable OpenClaw 2.0.0"
      : "node activation failed",
  );

  expect(duringBackupVerification.run).toBeUndefined();
  expect(failLauncherCopy.run).toBeUndefined();
  expect(liveVersion()).toBe(expected);
  if (when === "none") {
    expect(warn).not.toHaveBeenCalled();
  } else if (when.includes("launcher-copy-fails")) {
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("without a settled service recovery"),
    );
  } else {
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("replaced by another install"));
  }
});

it.each([
  ["published", "3.0.0"],
  // The update fails its own restart check and renames the copy it replaced back.
  ["published and rolled back", "1.0.0"],
] as const)(
  "refuses to replace a copy another update %s while it waited to activate",
  async (change, expected) => {
    await writePackageRoot(packageRoot(), "1.0.0");
    fs.mkdirSync(durable().binDir, { recursive: true });
    fs.writeFileSync(path.join(durable().binDir, "openclaw"), "launcher 1.0.0\n");
    const held = path.join(root, "held-1.0.0");
    // The real swap reads its baseline before the activation gate, as the package updater does.
    runGlobalPackageUpdateSteps.mockImplementation(
      async (params: Parameters<typeof publish>[2] & { beforeActivate: () => Promise<void> }) => {
        const staged = await stage("install-stage", "2.0.0");
        if (change !== "published") {
          // `openclaw update` publishes 3.0.0 during npm staging and keeps 1.0.0 aside.
          fs.renameSync(packageRoot(), held);
          await writePackageRoot(packageRoot(), "3.0.0");
        }
        await params.validateCandidate?.(staged.packageRoot);
        const result = await swapStagedPackageInstall({
          installTarget: createNpmTarget(durable().globalRoot),
          packageName: "openclaw",
          stage: staged,
          // The update changes the copy while this install waits for its service install.
          beforeActivate: async () => {
            if (change === "published") {
              await publish("update-stage", "3.0.0");
            } else {
              fs.rmSync(packageRoot(), { recursive: true });
              fs.renameSync(held, packageRoot());
            }
            await params.beforeActivate();
          },
          onTransaction: params.onTransaction,
        }).catch((error: unknown) => {
          throw error instanceof PackageUpdateActivationError ? error.cause : error;
        });
        return { failedStep: result.status === "committed" ? null : result.step };
      },
    );
    const warn = vi.fn();
    let mutated = false;

    await expect(
      installDurableServiceCli({
        env: env(),
        replacement: {
          version: "2.0.0",
          globalRoot: durable().globalRoot,
          packageRoot: packageRoot(),
          entrypoint: path.join(packageRoot(), "dist", "index.js"),
        },
        install: async (beforeMutation, beforeRecovery) => {
          await beforeMutation?.();
          mutated = true;
          await beforeRecovery?.();
          throw new Error("node activation failed");
        },
        verify: async () => true,
        warn,
      }),
    ).rejects.toThrow("changed while this install waited");

    expect(mutated).toBe(false);
    expect(liveVersion()).toBe(expected);
    expect(warn).not.toHaveBeenCalled();
  },
);
