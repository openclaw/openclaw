import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { readPackageReleaseIdentity } from "./package-release-slot.js";
import { createPackageReleasePrefixFixture } from "./package-release-slot.test-support.js";
import { packageActivationIdentity } from "./package-update-activation-paths.js";
import { writePackageRoot } from "./package-update-steps.test-support.js";
import {
  readManagedHandoffUpdateRun,
  recoverInterruptedManagedUpdate,
} from "./update-managed-service-handoff-interrupted.js";
import { createUpdateRun, recordUpdateRunPhase } from "./update-run-ledger.js";

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-interrupted-release-")));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(dir, "state"));
});
afterEach(async () => {
  await closeStateDatabaseForTest();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function interruptedSwitch() {
  const fixture = createPackageReleasePrefixFixture(dir);
  const releases: Record<string, string> = {};
  for (const [id, version] of [
    ["r1", "2026.11.3"],
    ["r2", "2026.12.1"],
    ["r3", "2026.12.2"],
  ] as const) {
    releases[id] = fixture.addRelease(id, version);
    // A verifiable installed package, as the helper checks before restarting it.
    await writePackageRoot(releases[id], version);
  }
  fixture.linkTo("r1");
  const original = packageActivationIdentity(releases.r1!, true);
  const env = { ...process.env };
  const run = createUpdateRun({ trigger: "cli" }, { env });
  recordUpdateRunPhase(
    run.runId,
    "activating",
    {
      origin: {
        packageRelease: {
          slot: fixture.slot,
          from: await readPackageReleaseIdentity(releases.r1!),
          to: await readPackageReleaseIdentity(releases.r2!),
        },
      },
    },
    { env },
  );
  const recover = (finalize = vi.fn(async () => readManagedHandoffUpdateRun(run.runId))) => ({
    finalize,
    outcome: recoverInterruptedManagedUpdate({
      root: fixture.slot,
      runId: run.runId,
      owner: "helper",
      databaseIdentity: {} as never,
      original: { serviceRestartSafe: true, version: "2026.11.3" },
      originalIdentity: original,
      timeoutMs: 10_000,
      assertCurrent: () => {},
      finalize,
    }),
  });
  return { fixture, recover };
}

describe.skipIf(process.platform === "win32")(
  "interrupted managed update on a release link",
  () => {
    it("continues with the recorded candidate when the link names it", async () => {
      const { fixture, recover } = await interruptedSwitch();
      fixture.linkTo("r2");
      const { finalize, outcome } = recover();
      await expect(outcome).resolves.toMatchObject({
        status: "succeeded",
        recovery: { serviceRestartSafe: true, version: "2026.12.1" },
      });
      // Post-core repair runs from the release the link names.
      expect(finalize).toHaveBeenCalledTimes(1);
    });

    it("treats the old link as not activated", async () => {
      const { recover } = await interruptedSwitch();
      const { finalize, outcome } = recover();
      await expect(outcome).resolves.toMatchObject({ status: "rolled-back" });
      expect(finalize).not.toHaveBeenCalled();
    });

    it("refuses a link that names neither recorded release", async () => {
      const { fixture, recover } = await interruptedSwitch();
      fixture.linkTo("r3");
      await expect(recover().outcome).rejects.toThrow(/recorded candidate/u);
    });
  },
);
