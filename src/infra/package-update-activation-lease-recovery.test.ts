import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openPackageActivationJournal } from "./package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import {
  assertNoPendingPackageActivation,
  runPackageActivationRecovery,
  settlePendingPackageActivation,
} from "./package-update-activation.js";
import * as temporaryRoot from "./tmp-openclaw-dir.js";
import * as managedHandoff from "./update-managed-service-handoff-lease.js";

const fixtures = createPackageActivationLifetimeFixture();
let root: string;
beforeEach(() => {
  ({ root } = fixtures.setup());
});
afterEach(async () => {
  try {
    await fixtures.lifetime.cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

function replaceLeaseDirectoryOwner(databasePath: string) {
  fs.unlinkSync(databasePath);
  const directory = path.dirname(databasePath);
  const lstat = fs.lstatSync;
  vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
    const stat = lstat(...args);
    if (stat && String(args[0]) === directory) {
      Object.defineProperty(stat, "uid", {
        value: typeof stat.uid === "bigint" ? stat.uid + 1n : stat.uid + 1,
      });
    }
    return stat;
  });
  const privateDirectory = path.join(root, "current-private-tmp");
  fs.mkdirSync(privateDirectory, { mode: 0o700 });
  vi.mocked(temporaryRoot.resolvePreferredOpenClawTmpDir).mockReturnValue(privateDirectory);
  const currentDatabase = path.join(privateDirectory, "managed-update-handoffs.sqlite");
  vi.mocked(managedHandoff.resolveManagedUpdateLeaseDatabasePath).mockReturnValue(currentDatabase);
  return { directory, currentDatabase };
}

describe.skipIf(process.platform === "win32")(
  "package recovery after temp ownership changes",
  () => {
    it("settles a missing recorded lease under current private ownership", async () => {
      const f = await fixtures.prepare();
      const record = openPackageActivationJournal(f.anchor).read();
      const manifest = fs.readFileSync(path.join(f.packageRoot, "package.json"));
      const launcher = fs.readFileSync(f.launcher);
      const { directory, currentDatabase } = replaceLeaseDirectoryOwner(
        record.descriptor.authority.databasePath,
      );
      const before = fs.readdirSync(directory);

      await expect(settlePendingPackageActivation(f.packageRoot)).resolves.toMatchObject({
        reason: "recovery-lease-missing",
        retained: `${f.anchor}.superseded-${f.operationId}`,
      });

      expect(fs.readdirSync(directory)).toEqual(before);
      expect(fs.existsSync(currentDatabase)).toBe(true);
      expect(fs.readFileSync(path.join(f.packageRoot, "package.json"))).toEqual(manifest);
      expect(fs.readFileSync(f.launcher)).toEqual(launcher);
      expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
    });

    it("replays a completed receipt without recreating a foreign user's lease", async () => {
      const f = await fixtures.prepare();
      await runPackageActivationRecovery(f.anchor, "repair", f.operationId);
      await runPackageActivationRecovery(f.anchor, "retire", f.operationId);
      const record = openPackageActivationJournal(f.anchor).read();
      const { directory, currentDatabase } = replaceLeaseDirectoryOwner(
        record.descriptor.authority.databasePath,
      );
      const before = fs.readdirSync(directory);

      await expect(
        runPackageActivationRecovery(f.anchor, "repair", f.operationId),
      ).resolves.toMatchObject({
        phase: "complete",
        operationId: f.operationId,
      });
      expect(fs.readdirSync(directory)).toEqual(before);
      expect(fs.existsSync(currentDatabase)).toBe(true);
    });
  },
);
