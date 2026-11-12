import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { createDoctorOriginalCaptureHook } from "./doctor-original-capture-admission.js";
import * as originalCapture from "./doctor-original-capture.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.skipIf(process.platform === "win32").each(["current", "revoked", "aborted"])(
  "restores the existing capture root only after current Doctor admission: %s",
  async (admission) => {
    const parent = dirs.make("doctor-admitted-capture-");
    const stateDir = path.join(parent, "state");
    const root = `${stateDir}.update-captures`;
    fs.mkdirSync(stateDir);
    fs.mkdirSync(root);
    fs.chmodSync(root, 0o2770);
    const before = fs.lstatSync(root, { bigint: true });
    let current = true;
    const controller = new AbortController();
    const scope = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent() {
        if (!current) {
          throw new Error("repair authority revoked");
        }
      },
    });
    // Capture transport is isolated; actual maintenance admission and filesystem repair run.
    const capture = vi
      .spyOn(originalCapture, "preserveDoctorOriginalState")
      .mockImplementation(async () => {
        expect(fs.statSync(root).mode & 0o7777).toBe(0o700);
      });
    const hook = createDoctorOriginalCaptureHook({
      root: null,
      runtime: { log() {}, error() {}, exit() {} },
      json: true,
    });
    try {
      const pending = scope.run(() =>
        hook({ env: { OPENCLAW_STATE_DIR: stateDir }, signal: controller.signal }),
      );
      // The dynamic dependencies yield before the effect.
      if (admission === "revoked") {
        current = false;
      } else if (admission === "aborted") {
        controller.abort(new Error("repair cancelled"));
      }
      if (admission === "current") {
        await pending;
        expect(capture).toHaveBeenCalledOnce();
      } else {
        await expect(pending).rejects.toThrow(/repair authority revoked|repair cancelled/);
        expect(capture).not.toHaveBeenCalled();
        const after = fs.lstatSync(root, { bigint: true });
        expect(after.mode).toBe(before.mode);
        expect(after.ctimeNs).toBe(before.ctimeNs);
      }
    } finally {
      current = true;
      await scope.close();
    }
  },
);
