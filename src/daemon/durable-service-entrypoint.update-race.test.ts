import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNpmTarget, writePackageRoot } from "../infra/package-update-steps.test-support.js";
import type { PackageUpdateTransaction } from "../infra/package-update-swap-contract.js";
import { swapStagedPackageInstall } from "../infra/package-update-swap.js";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "../infra/update-npm-prefix.js";
import { installDurableServiceCli } from "./durable-service-entrypoint.js";

const { runGlobalPackageUpdateSteps } = vi.hoisted(() => ({
  runGlobalPackageUpdateSteps: vi.fn(),
}));

// mock-isolation: npm staging is replaced by a prepared stage; the real package swap and its
// rollback still run against the durable copy on disk.
vi.mock("../infra/package-update-steps.js", () => ({ runGlobalPackageUpdateSteps }));
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

/** The real package swap of `openclaw update` and of a service install, into the durable copy. */
async function publish(
  name: string,
  version: string,
  onTransaction?: (transaction: PackageUpdateTransaction) => void | Promise<void>,
) {
  const result = await swapStagedPackageInstall({
    installTarget: createNpmTarget(durable().globalRoot),
    packageName: "openclaw",
    stage: await stage(name, version),
    ...(onTransaction ? { onTransaction } : {}),
  });
  expect(result.status, result.step.stderrTail ?? "").toBe("committed");
}

it("keeps a copy that openclaw update published when a failed install would restore its own", async () => {
  await writePackageRoot(packageRoot(), "1.0.0");
  fs.mkdirSync(durable().binDir, { recursive: true });
  fs.writeFileSync(path.join(durable().binDir, "openclaw"), "launcher 1.0.0\n");
  runGlobalPackageUpdateSteps.mockImplementation(
    async (params: {
      beforeActivate?: () => Promise<void>;
      onTransaction?: (transaction: PackageUpdateTransaction) => void | Promise<void>;
    }) => {
      await params.beforeActivate?.();
      await publish("install-stage", "2.0.0", params.onTransaction);
      return { failedStep: null };
    },
  );
  const warn = vi.fn();

  // A node install publishes 2.0.0; `openclaw update` then publishes 3.0.0 before the node
  // install's activation fails.
  await expect(
    installDurableServiceCli({
      env: env(),
      replacement: {
        version: "2.0.0",
        globalRoot: durable().globalRoot,
        packageRoot: packageRoot(),
        entrypoint: path.join(packageRoot(), "dist", "index.js"),
      },
      install: async (beforeMutation) => {
        await beforeMutation?.();
        expect(liveVersion()).toBe("2.0.0");
        await publish("update-stage", "3.0.0");
        throw new Error("node activation failed");
      },
      verify: async () => true,
      warn,
    }),
  ).rejects.toThrow("node activation failed");

  expect(liveVersion()).toBe("3.0.0");
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("replaced by another install"));
});
