import fs from "node:fs/promises";
import path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";
import { resolveStateDir } from "../config/paths.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import * as diskSpace from "../infra/disk-space.js";
import * as inspection from "../infra/update-candidate-state.inspection.js";
import { resolveUpdateCaptureRoot } from "../infra/update-capture-paths.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../infra/update-managed-service-handoff-lease.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import {
  getErrorOutput,
  getLogOutput,
  lastWriteJsonCall,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import { getUpdateRun, updateCommand } from "./update-cli-modules.test-support.js";

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
        const preload = path.join(setup.tempDirs.make("capture-space-preload-"), "capacity.cjs");
        await fs.writeFile(
          preload,
          `
const fs = require('node:fs');
const original = fs.statfsSync;
fs.statfsSync = function (target, ...args) {
  const result = original.call(this, target, ...args);
  return String(target).startsWith(${JSON.stringify(store + path.sep)}) && String(target).endsWith('.databases')
    ? { ...result, bsize: 1, bavail: ${availableBytes} }
    : result;
};
require('node:module').syncBuiltinESMExports();
`,
        );
        const runWorker = inspection.runUpdateStateInspectionWorker;
        vi.spyOn(inspection, "runUpdateStateInspectionWorker").mockImplementation((params) =>
          runWorker({
            ...params,
            sourceEnv: {
              ...params.sourceEnv,
              NODE_OPTIONS: `${params.sourceEnv.NODE_OPTIONS ?? ""} --require ${JSON.stringify(preload)}`,
            },
          }),
        );
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
