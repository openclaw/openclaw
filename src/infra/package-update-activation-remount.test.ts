import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import * as durability from "./directory-durability.js";
import * as journalModule from "./package-update-activation-journal.js";
import {
  openPackageActivationJournal,
  openPackageActivationSettlementJournal,
  resolvePackageActivationControl,
  resolvePackageActivationHelper,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import { prepareRemountedPublication } from "./package-update-activation-remount.test-support.js";
import {
  assertNoPendingPackageActivation,
  readPackageActivationReceipt,
  readPackageActivationStatus,
  runPackageActivationRecovery,
  settlePendingPackageActivation,
  settleRemountedPackageActivation,
} from "./package-update-activation.js";
import { legacyPackageFingerprint } from "./package-update-legacy.test-support.js";

const { setup, prepare, lifetime } = createPackageActivationLifetimeFixture();
beforeEach(() => {
  setup();
});
afterEach(async () => {
  try {
    await lifetime.cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

describe.skipIf(process.platform === "win32")("completed package receipt history", () => {
  it.each([
    "device",
    "settled-evidence",
    "helper-replaced",
    "anchor-replaced",
    "journal-inode",
    "package-inode",
    "lease-identity",
    "missing-lease",
    "non-linux",
    "installation-key",
    "active",
  ] as const)(
    "keeps %s drift historical without admitting unfinished or foreign work",
    async (scenario) => {
      const first = await prepare();
      if (scenario === "settled-evidence") {
        fs.renameSync(first.packageRoot, `${first.packageRoot}.original`);
        fs.mkdirSync(first.packageRoot, { mode: 0o700 });
        fs.writeFileSync(
          path.join(first.packageRoot, "package.json"),
          '{"name":"openclaw","version":"3.0.0"}',
        );
        // A completed older repair can still leave its receipt in the active slot.
        await expect(
          settlePendingPackageActivation(first.packageRoot, () => {
            throw new Error("reporting interrupted before archival");
          }),
        ).rejects.toThrow("reporting interrupted before archival");
      } else if (scenario !== "active") {
        await runPackageActivationRecovery(first.anchor, "repair", first.operationId);
        await runPackageActivationRecovery(first.anchor, "retire", first.operationId);
      }
      const record = openPackageActivationJournal(first.anchor).read();
      const differentInode = (identity: string) =>
        identity.replace(/\d+$/u, (inode) => String(BigInt(inode) + 1n));
      if (scenario === "helper-replaced") {
        fs.writeFileSync(resolvePackageActivationHelper(first.anchor), "historical replacement");
      } else if (scenario === "anchor-replaced") {
        fs.mkdirSync(first.anchor, { mode: 0o700 });
        fs.writeFileSync(path.join(first.anchor, "note.txt"), "historical replacement");
      } else if (scenario === "journal-inode") {
        record.descriptor.journalIdentity = differentInode(record.descriptor.journalIdentity);
      } else if (scenario === "package-inode") {
        record.descriptor.candidate.identity = differentInode(record.descriptor.candidate.identity);
        record.descriptor.preparation = record.descriptor.preparation.map((entry) =>
          entry.name === "candidate"
            ? { ...entry, identity: record.descriptor.candidate.identity }
            : entry,
        );
      } else if (scenario === "lease-identity") {
        record.descriptor.authority.databaseIdentity = differentInode(
          record.descriptor.authority.databaseIdentity,
        );
      } else if (scenario === "missing-lease") {
        fs.renameSync(
          record.descriptor.authority.databasePath,
          `${record.descriptor.authority.databasePath}.old`,
        );
      } else if (scenario === "installation-key") {
        record.descriptor.authority.installKey = `${first.packageRoot}-other`;
      } else if (scenario === "settled-evidence") {
        // Evidence remains active when reporting interrupts archival, but the
        // durable close is already final. Its removal cannot rearm recovery.
        fs.rmSync(first.anchor, { recursive: true });
        fs.unlinkSync(resolvePackageActivationHelper(first.anchor));
      }
      const historical = (value: unknown) =>
        JSON.stringify(value, (_key, entry: unknown) => {
          if (typeof entry !== "string" || !/^\d+:\d+$/u.test(entry)) {
            return entry;
          }
          return entry.replace(/^\d+/u, (device) => String(BigInt(device) + 1n));
        });
      const journalPath = resolvePackageActivationJournalPath(first.anchor);
      const database = new DatabaseSync(journalPath);
      try {
        database
          .prepare("UPDATE package_activation SET descriptor_json = ?, intent_json = ?")
          .run(historical(record.descriptor), historical(record.intent));
      } finally {
        database.close();
      }
      const before = fs.readFileSync(journalPath);
      const platform = vi
        .spyOn(process, "platform", "get")
        .mockReturnValue(scenario === "non-linux" ? "darwin" : "linux");
      try {
        if (scenario === "active" || scenario === "installation-key") {
          expect(() => assertNoPendingPackageActivation(first.packageRoot)).toThrow(
            "does not match its installation",
          );
          expect(fs.readFileSync(journalPath)).toEqual(before);
          return;
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          expect(() => assertNoPendingPackageActivation(first.packageRoot)).not.toThrow();
          expect(readPackageActivationReceipt(first.packageRoot)).toMatchObject({
            phase: "complete",
          });
          await expect(
            readPackageActivationStatus(first.anchor, first.operationId),
          ).resolves.toMatchObject({ phase: "complete" });
          await expect(
            runPackageActivationRecovery(first.anchor, "retire", first.operationId),
          ).resolves.toMatchObject({ phase: "complete" });
          expect(fs.existsSync(resolvePackageActivationHelper(first.anchor))).toBe(
            scenario === "helper-replaced",
          );
          expect(fs.readFileSync(journalPath)).toEqual(before);
        }
      } finally {
        platform.mockRestore();
      }
      const second = await prepare();
      if (scenario === "helper-replaced" || scenario === "anchor-replaced") {
        const preserved = scenario === "helper-replaced" ? "control/recovery.mjs" : "note.txt";
        expect(
          fs.readFileSync(`${first.anchor}.superseded-${first.operationId}/${preserved}`, "utf8"),
        ).toBe("historical replacement");
      }
      expect(second.operationId).not.toBe(first.operationId);
      expect(openPackageActivationJournal(second.anchor).read().phase).toBe("prepared");
    },
  );
});

describe.skipIf(process.platform === "win32")("unfinished remounted publication settlement", () => {
  const fixture = createPackageActivationLifetimeFixture();
  afterEach(async () => {
    await fixture.lifetime.cleanup();
  });

  it.each(["settle", "archive-interrupted"] as const)(
    "verifies and preserves the installed candidate: %s",
    async (scenario) => {
      const { root } = fixture.setup();
      const f = await prepareRemountedPublication(fixture, root);
      const liveTree = legacyPackageFingerprint(f.packageRoot);
      const previousTree = legacyPackageFingerprint(path.join(f.anchor, "previous"));
      const liveBytes = fs.readFileSync(path.join(f.packageRoot, "package.json"));
      // Verification reads the link, which may advance its atime (Linux relatime).
      const launcherState = () => {
        const { dev, ino, mode, nlink, uid, gid, size, mtimeNs, ctimeNs } = fs.lstatSync(
          f.launcher,
          { bigint: true },
        );
        const target = fs.readlinkSync(f.launcher);
        return { dev, ino, mode, nlink, uid, gid, size, mtimeNs, ctimeNs, target };
      };
      const launcher = launcherState();
      const previousBytes = fs.readFileSync(path.join(f.anchor, "previous/package.json"));
      const helperBytes = fs.readFileSync(resolvePackageActivationHelper(f.anchor));
      const before = fs.readFileSync(f.journalPath);
      expect(() =>
        openPackageActivationSettlementJournal(f.anchor).readForAdmission(f.packageRoot),
      ).toThrow("does not match its installation");
      expect(() => assertNoPendingPackageActivation(f.packageRoot)).toThrow(
        "does not match its installation",
      );
      await expect(readPackageActivationStatus(f.anchor, f.operationId)).rejects.toThrow(
        "does not match its installation",
      );
      await expect(settlePendingPackageActivation(f.packageRoot)).rejects.toThrow(
        "does not match its installation",
      );
      expect(fs.readFileSync(f.journalPath)).toEqual(before);
      const rename = fs.renameSync;
      const cut =
        scenario === "archive-interrupted"
          ? vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
              if (String(source) === `${f.anchor}.control`) {
                throw new Error("archive interrupted");
              }
              return rename(source, destination);
            })
          : undefined;
      const result = await settleRemountedPackageActivation(f.anchor, f.operationId);
      expect(result).toMatchObject({ reason: "publication-settled-external-change" });
      cut?.mockRestore();
      if (scenario === "archive-interrupted") {
        const closed = openPackageActivationJournal(f.anchor).read();
        expect(closed.phase).toBe("superseded");
        await settlePendingPackageActivation(f.packageRoot, undefined, closed);
      }
      const retained = `${f.anchor}.superseded-${f.operationId}`;
      const db = new DatabaseSync(path.join(retained, "control/operation.sqlite"), {
        readOnly: true,
      });
      try {
        const row = db.prepare("SELECT * FROM package_activation").get()!;
        expect(row.phase).toBe("superseded");
        expect(JSON.parse(String(row.intent_json))).toMatchObject({
          kind: "publication-settled-external-change",
          settled: true,
        });
        expect(JSON.parse(String(row.descriptor_json))).toEqual(f.historical);
      } finally {
        db.close();
      }
      expect(legacyPackageFingerprint(f.packageRoot)).toEqual(liveTree);
      expect(legacyPackageFingerprint(path.join(retained, "previous"))).toEqual(previousTree);
      expect(fs.readFileSync(path.join(f.packageRoot, "package.json"))).toEqual(liveBytes);
      expect(launcherState()).toEqual(launcher);
      expect(fs.readFileSync(path.join(retained, "previous/package.json"))).toEqual(previousBytes);
      expect(fs.readFileSync(path.join(retained, "control/recovery.mjs"))).toEqual(helperBytes);
      expect(fs.existsSync(f.journalPath)).toBe(false);
      expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
    },
  );

  it.each(["before-commit", "before-archive"] as const)(
    "refuses settlement after executor ownership is reassigned: %s",
    async (scenario) => {
      const { root } = fixture.setup();
      const f = await prepareRemountedPublication(fixture, root);
      const before = fs.readFileSync(f.journalPath);
      const reassign = () => {
        const lease = new DatabaseSync(f.historical.authority.databasePath);
        try {
          const { changes } = lease
            .prepare("UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?")
            .run(randomUUID(), f.packageRoot);
          expect(changes).toBe(1);
        } finally {
          lease.close();
        }
      };
      if (scenario === "before-commit") {
        // Reassign after the full-tree verification, at the launcher sync before the close.
        const sync = durability.syncDirectory;
        vi.spyOn(durability, "syncDirectory").mockImplementation(async (directory) => {
          const result = await sync(directory);
          if (directory === path.dirname(f.launcher)) {
            reassign();
          }
          return result;
        });
      } else {
        // Reassign after the durable close, immediately before evidence archival.
        const open = journalModule.openPackageActivationSettlementJournal;
        vi.spyOn(journalModule, "openPackageActivationSettlementJournal").mockImplementation(
          (anchor) => {
            const journal = open(anchor);
            return {
              ...journal,
              archiveSettled(expected, assertCurrent) {
                reassign();
                return journal.archiveSettled(expected, assertCurrent);
              },
            };
          },
        );
      }
      const refusal = await settleRemountedPackageActivation(f.anchor, f.operationId).then(
        () => undefined,
        (error: unknown) => error,
      );
      // The executor reports its pending release and keeps the settlement refusal as the cause.
      expect(refusal).toMatchObject({
        message: "Update failed and executor release remains pending",
        cause: { cause: { message: "Update executor ownership is no longer current." } },
      });
      if (scenario === "before-commit") {
        expect(fs.readFileSync(f.journalPath)).toEqual(before);
      } else {
        expect(openPackageActivationJournal(f.anchor).read()).toMatchObject({
          phase: "superseded",
          intent: { kind: "publication-settled-external-change", settled: true },
        });
      }
      expect(fs.existsSync(resolvePackageActivationControl(f.anchor))).toBe(true);
      expect(fs.existsSync(`${f.anchor}.superseded-${f.operationId}`)).toBe(false);
      expect(fs.existsSync(path.join(f.anchor, "previous"))).toBe(true);
      expect(fs.existsSync(f.packageRoot)).toBe(true);
    },
  );

  it.each([
    "content",
    "after-verification",
    "metadata",
    "launcher",
    "rewritten-original-launcher",
    "inode",
    "device-map",
    "helper",
    "journal-mode",
    "journal-hardlink",
    "operation",
    "active-lease",
    "rollback",
  ] as const)("refuses %s without closing or replacing anything", async (scenario) => {
    const { root } = fixture.setup();
    const f = await prepareRemountedPublication(
      fixture,
      root,
      false,
      scenario === "rewritten-original-launcher" ? "different-files" : "equal-symlinks",
    );
    if (scenario === "rewritten-original-launcher") {
      const before = fs.lstatSync(f.launcher, { bigint: true });
      fs.writeFileSync(f.launcher, fs.readFileSync(path.join(f.anchor, "launchers/openclaw")));
      expect(fs.lstatSync(f.launcher, { bigint: true }).ino).toBe(before.ino);
    }
    if (scenario === "content") {
      fs.appendFileSync(path.join(f.packageRoot, "openclaw.mjs"), "changed");
    }
    if (scenario === "metadata") {
      const target = path.join(f.packageRoot, "openclaw.mjs");
      fs.chmodSync(target, (fs.statSync(target).mode & 0o777) ^ 0o100);
    }
    if (scenario === "after-verification") {
      const sync = durability.syncDirectory;
      vi.spyOn(durability, "syncDirectory").mockImplementation(async (directory) => {
        const result = await sync(directory);
        if (directory === path.dirname(f.launcher)) {
          fs.appendFileSync(path.join(f.packageRoot, "openclaw.mjs"), "changed after verification");
        }
        return result;
      });
    }
    if (scenario === "launcher") {
      fs.unlinkSync(f.launcher);
      fs.symlinkSync("other-target", f.launcher);
    }
    if (scenario === "helper") {
      fs.appendFileSync(resolvePackageActivationHelper(f.anchor), "changed");
    }
    if (scenario === "journal-mode") {
      fs.chmodSync(f.journalPath, 0o644);
    }
    if (scenario === "journal-hardlink") {
      fs.linkSync(f.journalPath, `${f.journalPath}.link`);
    }
    if (["inode", "device-map", "rollback"].includes(scenario)) {
      const d = structuredClone(f.historical);
      if (scenario === "inode") {
        d.binIdentity = d.binIdentity.replace(/\d+$/u, (n) => String(BigInt(n) + 1n));
      }
      if (scenario === "device-map") {
        d.binIdentity = d.binIdentity.replace(/^\d+/u, (n) => String(BigInt(n) + 1n));
      }
      const db = new DatabaseSync(f.journalPath);
      try {
        db.prepare("UPDATE package_activation SET descriptor_json = ?, phase = ?").run(
          JSON.stringify(d),
          scenario === "rollback" ? "rollback-in-progress" : "publishing",
        );
      } finally {
        db.close();
      }
    }
    const before = fs.readFileSync(f.journalPath);
    const refuse = () =>
      expect(
        settleRemountedPackageActivation(
          f.anchor,
          scenario === "operation" ? randomUUID() : f.operationId,
        ),
      ).rejects.toThrow();
    if (scenario === "active-lease") {
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        await executor.enter(f.packageRoot);
        await refuse();
      });
    } else {
      await refuse();
    }
    expect(fs.readFileSync(f.journalPath)).toEqual(before);
    expect(fs.existsSync(path.join(f.anchor, "previous"))).toBe(true);
    expect(fs.existsSync(f.packageRoot)).toBe(true);
    if (scenario === "journal-mode") {
      fs.chmodSync(f.journalPath, 0o600);
    }
  });
});
