import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import * as activationJournal from "./package-update-activation-journal.js";
import {
  openPackageActivationJournal,
  packageActivationIdentity,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import {
  assertNoPendingPackageActivation,
  readPackageActivationReceipt,
  readPackageActivationStatus,
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
    it("reports prepared recovery without recreating the missing lease database", async () => {
      const f = await fixtures.prepare();
      const record = openPackageActivationJournal(f.anchor).read();
      fs.unlinkSync(record.descriptor.authority.databasePath);
      const before = fixtures.snapshotControl(f.anchor);
      await expect(readPackageActivationStatus(f.anchor, f.operationId)).resolves.toMatchObject({
        phase: "prepared",
        operationId: f.operationId,
      });
      expect(readPackageActivationReceipt(f.packageRoot)).toMatchObject({ phase: "prepared" });
      expect(fixtures.snapshotControl(f.anchor)).toEqual(before);
      expect(fs.existsSync(record.descriptor.authority.databasePath)).toBe(false);
      const journalPath = resolvePackageActivationJournalPath(f.anchor);
      fs.chmodSync(journalPath, 0o640);
      await expect(readPackageActivationStatus(f.anchor, f.operationId)).rejects.toThrow(
        "owner-only permissions",
      );
      expect(fs.statSync(journalPath).mode & 0o777).toBe(0o640);
    });

    it.each(["original helper", "separate helper", "automatic update"] as const)(
      "archives unpublished preparation after lease loss through %s",
      async (entry) => {
        const stage = path.join(root, "live/lib/node_modules/.openclaw.update-stage-reboot");
        const f = await fixtures.prepare(() => {
          fs.renameSync(path.join(root, "stage"), stage);
          fs.symlinkSync(stage, path.join(root, "stage"));
        });
        fs.writeFileSync(path.join(stage, "evidence"), "interrupted npm stage\n");
        const sibling = path.join(path.dirname(stage), ".openclaw.update-stage-another-owner");
        fs.mkdirSync(sibling);
        const record = openPackageActivationJournal(f.anchor).read();
        expect(record).toMatchObject({ phase: "prepared", intent: null, publications: [] });
        const leaseDirectory = path.dirname(record.descriptor.authority.databasePath);
        fs.renameSync(leaseDirectory, `${leaseDirectory}.before-reboot`);
        const manifest = fs.readFileSync(path.join(f.packageRoot, "package.json"));
        const launcher = fs.readFileSync(f.launcher);
        const candidate = fs.readFileSync(path.join(f.anchor, "candidate/package.json"));
        const control = fixtures.snapshotControl(f.anchor);
        if (entry === "original helper") {
          await expect(
            runPackageActivationRecovery(f.anchor, "repair", f.operationId),
          ).resolves.toMatchObject({ phase: "complete" });
        } else {
          await expect(
            settlePendingPackageActivation(
              f.packageRoot,
              undefined,
              undefined,
              entry === "separate helper" ? { operationId: f.operationId } : { automatic: true },
            ),
          ).resolves.toMatchObject({
            reason: "recovery-lease-missing",
            warning: expect.stringMatching(/unpublished|prepared/iu),
          });
        }
        const retained = `${f.anchor}.superseded-${f.operationId}`;
        expect(fs.existsSync(f.anchor)).toBe(false);
        expect(fs.existsSync(stage)).toBe(false);
        expect(fs.existsSync(sibling)).toBe(true);
        expect(packageActivationIdentity(retained, true)).toBe(record.descriptor.anchorIdentity);
        expect(
          packageActivationIdentity(path.join(retained, "control/operation.sqlite"), false),
        ).toBe(record.descriptor.journalIdentity);
        expect(packageActivationIdentity(f.packageRoot, true)).toBe(
          record.descriptor.previous.identity,
        );
        expect(fs.readFileSync(path.join(retained, "update-stage/evidence"), "utf8")).toBe(
          "interrupted npm stage\n",
        );
        expect(fs.readFileSync(path.join(retained, "candidate/package.json"))).toEqual(candidate);
        // The journal records closure; the helper's inode and bytes survive archival.
        const helper = control.find((file) => file.name === "recovery.mjs")!;
        expect(fs.readFileSync(path.join(retained, "control/recovery.mjs"))).toEqual(helper.bytes);
        expect(fs.readFileSync(path.join(f.packageRoot, "package.json"))).toEqual(manifest);
        expect(fs.readFileSync(f.launcher)).toEqual(launcher);
        expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
      },
    );

    it.each(["launcher", "install", "publication", "phase", "intent"] as const)(
      "refuses missing-lease helper retirement after a %s change",
      async (change) => {
        const f = await fixtures.prepare();
        const record = openPackageActivationJournal(f.anchor).read();
        fs.unlinkSync(record.descriptor.authority.databasePath);
        if (change === "launcher" || change === "install") {
          const file = change === "launcher" ? f.launcher : f.packageRoot;
          fs.renameSync(file, `${file}.recorded`);
          if (change === "launcher") {
            fs.writeFileSync(file, "replacement launcher\n");
          } else {
            fs.mkdirSync(file);
          }
        } else {
          using db = new DatabaseSync(resolvePackageActivationJournalPath(f.anchor));
          if (change === "publication") {
            db.prepare("UPDATE package_activation SET publications_json = ?").run(
              JSON.stringify([
                { name: "openclaw", identity: record.descriptor.launchers[0]!.candidateIdentity },
              ]),
            );
          } else if (change === "phase") {
            db.exec("UPDATE package_activation SET phase = 'publishing'");
          } else {
            db.prepare("UPDATE package_activation SET intent_json = ?").run(
              JSON.stringify({ kind: "displace" }),
            );
          }
        }
        const before = fixtures.snapshotControl(f.anchor);
        await expect(
          runPackageActivationRecovery(f.anchor, "repair", f.operationId),
        ).rejects.toThrow(
          change === "launcher" ? "launcher identity changed" : /lease database identity changed/,
        );
        if (change === "launcher") {
          await expect(
            settlePendingPackageActivation(f.packageRoot, undefined, undefined, {
              automatic: true,
            }),
          ).rejects.toThrow("launcher identity changed");
        }
        expect(fixtures.snapshotControl(f.anchor)).toEqual(before);
        expect(fs.existsSync(f.anchor)).toBe(true);
        expect(fs.existsSync(`${f.anchor}.superseded-${f.operationId}`)).toBe(false);
      },
    );

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

    it.each(["close", "archive"] as const)(
      "refuses missing-lease helper settlement after ownership is reassigned before %s",
      async (boundary) => {
        const f = await fixtures.prepare();
        const initial = openPackageActivationJournal(f.anchor).read();
        const databasePath = initial.descriptor.authority.databasePath;
        fs.unlinkSync(databasePath);
        const before = fixtures.snapshotControl(f.anchor);
        const reassign = () => {
          using db = new DatabaseSync(databasePath);
          expect(
            db
              .prepare("UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?")
              .run(randomUUID(), f.packageRoot).changes,
          ).toBe(1);
        };
        const open = activationJournal.openPackageActivationSettlementJournal;
        vi.spyOn(activationJournal, "openPackageActivationSettlementJournal").mockImplementation(
          (anchor) => {
            const journal = open(anchor);
            return {
              ...journal,
              transition(...args) {
                if (boundary === "close") {
                  reassign();
                }
                return journal.transition(...args);
              },
              archiveSettled(...args) {
                if (boundary === "archive") {
                  reassign();
                }
                return journal.archiveSettled(...args);
              },
            };
          },
        );
        await expect(
          settlePendingPackageActivation(f.packageRoot, undefined, undefined, {
            operationId: f.operationId,
          }),
        ).rejects.toMatchObject({
          message: "Update failed and executor release remains pending",
          cause: { cause: { message: "Update executor ownership is no longer current." } },
        });
        if (boundary === "close") {
          expect(fixtures.snapshotControl(f.anchor)).toEqual(before);
        } else {
          expect(openPackageActivationJournal(f.anchor).read()).toMatchObject({
            phase: "superseded",
            intent: { kind: "recovery-lease-missing", settled: true },
          });
        }
        expect(fs.existsSync(f.anchor)).toBe(true);
        expect(fs.existsSync(`${f.anchor}.superseded-${f.operationId}`)).toBe(false);
      },
    );

    it("refuses helper repair and settlement while a fresh executor owns the replacement lease store", async () => {
      const f = await fixtures.prepare();
      const record = openPackageActivationJournal(f.anchor).read();
      fs.unlinkSync(record.descriptor.authority.databasePath);
      const before = fixtures.snapshotControl(f.anchor);
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        await executor.enter(f.packageRoot);
        await expect(
          runPackageActivationRecovery(f.anchor, "repair", f.operationId),
        ).rejects.toThrow("lease database identity changed");
        await expect(settlePendingPackageActivation(f.packageRoot)).rejects.toThrow(
          /executor.*owns/iu,
        );
      });
      expect(fixtures.snapshotControl(f.anchor)).toEqual(before);
      expect(fs.existsSync(f.anchor)).toBe(true);
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
