import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { createDoctorOriginalCaptureHook } from "./doctor-original-capture-admission.js";
import * as originalCapture from "./doctor-original-capture.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.skipIf(process.platform === "win32").each([false, true])(
  "restores private stores before capture only with current repair authority (revoked=%s)",
  async (revoked) => {
    const stateDir = dirs.make("doctor-admitted-permissions-");
    const directory = path.join(stateDir, "client");
    const store = path.join(directory, "credentials.sqlite");
    fs.mkdirSync(directory);
    fs.writeFileSync(store, "retained credential bytes");
    fs.chmodSync(directory, 0o2770);
    fs.chmodSync(store, 0o660);
    const before = [directory, store].map((file) => fs.lstatSync(file, { bigint: true }));
    let current = true;
    const scope = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent() {
        if (!current) {
          throw new Error("repair authority revoked");
        }
      },
    });
    // Capture I/O is the downstream boundary; permission restoration and admission stay real.
    const capture = vi
      .spyOn(originalCapture, "preserveDoctorOriginalState")
      .mockImplementation(async () => {
        expect(fs.statSync(directory).mode & 0o7777).toBe(0o700);
        expect(fs.statSync(store).mode & 0o7777).toBe(0o600);
        expect(fs.readFileSync(store, "utf8")).toBe("retained credential bytes");
        return { findings: [], warnings: [] };
      });
    const hook = createDoctorOriginalCaptureHook({
      root: null,
      runtime: { log() {}, error() {}, exit() {} },
      json: true,
      reportFindings() {},
    });
    try {
      const pending = scope.run(() =>
        hook({ env: { OPENCLAW_STATE_DIR: stateDir }, signal: new AbortController().signal }),
      );
      // The hook awaits its dependencies; authority can change before the filesystem effect.
      if (revoked) {
        current = false;
        await expect(pending).rejects.toThrow("repair authority revoked");
        expect(capture).not.toHaveBeenCalled();
        for (const [index, file] of [directory, store].entries()) {
          const after = fs.lstatSync(file, { bigint: true });
          expect(after.mode).toBe(before[index]!.mode);
          expect(after.ctimeNs).toBe(before[index]!.ctimeNs);
        }
      } else {
        await pending;
        expect(capture).toHaveBeenCalledOnce();
      }
    } finally {
      current = true;
      await scope.close();
    }
  },
);
