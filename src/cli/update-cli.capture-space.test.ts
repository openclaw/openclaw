import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assert, describe, expect, it, vi } from "vitest";
import { resolveStateDir } from "../config/paths.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import * as diskSpace from "../infra/disk-space.js";
import * as workerRuntime from "../infra/runtime-worker-url.js";
import { resolveUpdateCaptureRoot } from "../infra/update-capture-paths.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../infra/update-managed-service-handoff-lease.js";
import * as postCoreCapability from "../infra/update-post-core-capability.js";
import * as recoveryBaseline from "../infra/update-recovery-baseline-capture.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { VERSION } from "../version.js";
import {
  getErrorOutput,
  getLogOutput,
  lastWriteJsonCall,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as modules from "./update-cli-modules.test-support.js";
import { getUpdateRun, updateCommand } from "./update-cli-modules.test-support.js";
import { currentGitCoreFixture } from "./update-cli/update-command-runtime-recovery.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update without an original-state snapshot", () => {
  const setup = createUpdateCliFixture();

  it.each([
    { capture: "payload", json: true },
    { capture: "database", json: false },
  ] as const)(
    "continues successfully with a prominent $capture capacity warning (json=$json)",
    async ({ capture, json }) => {
      const handoff = resolvePathViaExistingAncestorSync(resolveManagedUpdateLeaseDatabasePath());
      expect(handoff).not.toBe(
        resolvePathViaExistingAncestorSync("/tmp/openclaw/managed-update-handoffs.sqlite"),
      );
      const root = await setup.mockPackageInstallAtCaseDir();
      const store = resolveUpdateCaptureRoot(resolveStateDir());
      const availableBytes = 12345;
      const fixtureRoot = setup.tempDirs.make("capture-space-fixture-");
      const measured = path.join(fixtureRoot, "capacity-measured");
      if (capture === "payload") {
        const readSpace = diskSpace.tryReadDiskSpace;
        vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) =>
          targetPath === store
            ? { targetPath, checkedPath: targetPath, availableBytes, totalBytes: 1024 ** 3 }
            : readSpace(targetPath),
        );
      } else {
        // The subprocess performs real discovery and backup preflight. Only statfs's
        // external capacity measurement is fixed, scoped to this run's capture tree.
        const preload = path.join(fixtureRoot, "capacity.cjs");
        const entry = path.join(fixtureRoot, "inspection.mjs");
        await fs.writeFile(
          preload,
          `
const fs = require('node:fs');
const original = fs.statfsSync;
fs.statfsSync = function (target, ...args) {
  const result = original.call(this, target, ...args);
  if (String(target).startsWith(${JSON.stringify(store + path.sep)}) && String(target).endsWith('.databases')) {
    fs.writeFileSync(${JSON.stringify(measured)}, "measured");
    return { ...result, bsize: 1, bavail: ${availableBytes} };
  }
  return result;
};
require('node:module').syncBuiltinESMExports();
`,
        );
        await fs.writeFile(
          entry,
          `import { fileURLToPath } from "node:url";
import ${JSON.stringify(pathToFileURL(preload).href)};
const [operation] = process.argv.splice(2, 1);
process.argv[1] = fileURLToPath(operation);
await import(operation);`,
        );
        const resolveArgv = workerRuntime.resolveRuntimeWorkerArgv;
        vi.spyOn(workerRuntime, "resolveRuntimeWorkerArgv").mockImplementation((url, execPath) => {
          const args = resolveArgv(url, execPath);
          return path.basename(url.pathname).startsWith("update-candidate-state.worker.")
            ? [...args.slice(0, -1), entry, url.href]
            : args;
        });
      }

      let result: UpdateRunResult | undefined;
      await updateCommand({
        yes: true,
        restart: false,
        json,
        onResult: (value) => {
          result = value;
        },
      });

      if (capture === "database") {
        expect(await fs.readFile(measured, "utf8")).toBe("measured");
      }
      expect(result?.status).toBe("ok");
      const runId = result?.runId;
      assert(runId);
      const run = getUpdateRun(runId);
      expect(run).toMatchObject({ status: "succeeded", phase: "finished" });
      const warning = run?.steps.find(
        (step) => step.step === "warning:original-state-capture:1",
      )?.detail;
      assert(warning);
      expect(warning).toMatch(/^NO ORIGINAL-STATE SNAPSHOT: insufficient disk space\./);
      expect(warning).toMatch(/Needed \d+ bytes/);
      if (capture === "payload") {
        // This fixture has no authored files: only the capture's 64 MiB reserve is needed.
        expect(warning).toContain("Needed 67108864 bytes");
      }
      expect(warning).toContain(`available ${availableBytes} bytes`);
      expect(warning).toContain("The update continues without a complete pre-update recovery copy");
      expect(warning).not.toMatch(/active writer|restart|retry/);
      expect(getErrorOutput()).toContain(`Warning: ${warning}`);
      if (json) {
        expect(lastWriteJsonCall()).toMatchObject({
          status: "ok",
          run: { steps: expect.arrayContaining([expect.objectContaining({ detail: warning })]) },
        });
      } else {
        expect(getLogOutput()).toContain(`Warning: ${warning}`);
      }
      expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))).toMatchObject({
        version: "9999.0.0",
      });
      await expect(fs.stat(path.join(store, runId, "manifest.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});

describe("update with a failed original-state capture", () => {
  const setup = createUpdateCliFixture();

  it.each([
    "SQLite file generation changed while reading",
    "State schema inventory failed (output-limit)",
  ])("continues a real update with a warning when the capture fails: %s", async (failure) => {
    await setup.mockPackageInstallAtCaseDir();
    const cause = `${failure}: /fixture/state/openclaw.sqlite`;
    vi.spyOn(recoveryBaseline, "captureUpdateRecoveryBaseline").mockRejectedValue(
      new Error("Original update capture failed; evidence retained at /fixture/capture", {
        cause: new Error(cause),
      }),
    );

    let result: UpdateRunResult | undefined;
    await updateCommand({
      yes: true,
      restart: false,
      json: true,
      onResult: (value) => {
        result = value;
      },
    });

    expect(result?.status).toBe("ok");
    // The capture ran at activation, after the run was registered; its warning joins the run.
    const warning = getUpdateRun(result!.runId!)?.steps.find(
      (step) => step.step === "warning:original-state-capture:1",
    )?.detail;
    assert(warning);
    expect(warning).toMatch(
      /^NO ORIGINAL-STATE SNAPSHOT: original state capture is unavailable\. The update continues without a complete pre-update recovery copy\. Database rollback uses the pre-migration snapshots taken after the Gateway stops\. A completed update does not need to be restarted because of this warning\. Cause: Original update capture failed; evidence retained at /,
    );
    expect(warning).toContain(cause);
    expect(warning).not.toContain("retry");
    expect(lastWriteJsonCall()).toMatchObject({
      run: {
        steps: expect.arrayContaining([
          expect.objectContaining({ step: "warning:original-state-capture:1", detail: warning }),
        ]),
      },
    });
    expect(getErrorOutput()).toContain(`Warning: ${warning}`);
  });
});

/** Run directories in the capture store; each one is a full copy of config and databases. */
async function captures(): Promise<string[]> {
  const store = resolveUpdateCaptureRoot(resolveStateDir());
  const entries = await fs.readdir(store, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

function captureSteps(runId: string | undefined) {
  expect(runId).toBeTruthy();
  return (modules.getUpdateRun(runId!)?.steps ?? [])
    .map((step) => step.step)
    .filter((step) => step === "original-state-capture");
}

describe("original-state capture follows the first state change", () => {
  const setup = createUpdateCliFixture();
  const output = () => lastWriteJsonCall() as UpdateRunResult;

  it.each(["package", "git"] as const)(
    "copies nothing when a %s update is already current",
    async (shape) => {
      mocks.readPackageVersion.mockResolvedValue(VERSION);
      if (shape === "package") {
        await setup.mockPackageInstallAtCaseDir(undefined, VERSION);
        setup.primeNpmChannelTag("latest", VERSION);
      } else {
        vi.mocked(modules.updateGitCheckout).mockResolvedValueOnce(
          currentGitCoreFixture(process.cwd(), VERSION).outcome,
        );
      }

      await modules.updateCommand({ yes: true, restart: false, json: true });

      expect(output()).toMatchObject({ status: "skipped", reason: "already-current" });
      expect(await captures()).toEqual([]);
      expect(captureSteps(output().runId)).toEqual([]);
    },
  );

  it("copies nothing when an update is refused before it changes state", async () => {
    await setup.mockPackageInstallAtCaseDir();
    vi.mocked(modules.fetchNpmPackageTargetStatus).mockResolvedValue({
      version: null,
      nodeEngine: null,
      error: "fixture registry unavailable",
    });

    await expect(modules.updateCommand({ yes: true, json: true })).rejects.toMatchObject({
      code: 1,
    });

    expect(output()).toMatchObject({ status: "error", reason: "target-metadata-preflight" });
    expect(await captures()).toEqual([]);
  });

  it("still copies the originals once before a real update activates", async () => {
    await setup.mockPackageInstallAtCaseDir();

    await modules.updateCommand({ yes: true, restart: false, json: true });

    const result = output();
    expect(result.status).toBe("ok");
    expect(await captures()).toEqual([result.runId]);
    const store = resolveUpdateCaptureRoot(resolveStateDir());
    await expect(fs.stat(path.join(store, result.runId!, "manifest.json"))).resolves.toBeTruthy();
    expect(captureSteps(result.runId)).toEqual(["original-state-capture"]);
  });

  it("copies the originals after this run prepares its package publication", async () => {
    await setup.mockPackageInstallAtCaseDir();
    // A delegated-post-core candidate gets a prepared publication journal before activation.
    vi.spyOn(postCoreCapability, "supportsPostCoreExecutor").mockResolvedValue(true);

    await modules.updateCommand({ yes: true, restart: false, json: true });

    const result = output();
    expect(getErrorOutput()).toContain("Package publication recovery:");
    expect(result).not.toMatchObject({ reason: "update-recovery-pending" });
    expect(await captures()).toEqual([result.runId]);
    expect(captureSteps(result.runId)).toEqual(["original-state-capture"]);
  });

  it("still copies the originals once before a real Git update mutates its checkout", async () => {
    mocks.readPackageVersion.mockResolvedValue(VERSION);
    const mutation = modules.mockGitUpdateAfterMutation(
      modules.makeOkUpdateResult({ mode: "git", root: process.cwd() }),
    );

    await modules.updateCommand({ yes: true, restart: false, json: true });

    const result = output();
    expect(result.status).toBe("ok");
    expect(mutation).toHaveBeenCalledOnce();
    expect(await captures()).toEqual([result.runId]);
    expect(captureSteps(result.runId)).toEqual(["original-state-capture"]);
  });

  it("copies nothing for a Gateway-started update, which carries its run id", async () => {
    await setup.mockPackageInstallAtCaseDir();
    vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", randomUUID());

    await modules.updateCommand({ yes: true, restart: false, json: true });

    expect(output().status).toBe("ok");
    expect(await captures()).toEqual([]);
  });
});
