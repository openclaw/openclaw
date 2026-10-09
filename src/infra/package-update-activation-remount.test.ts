import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openPackageActivationJournal,
  resolvePackageActivationHelper,
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
      if (scenario === "helper-replaced" || scenario === "anchor-replaced") {
        await settlePendingPackageActivation(first.packageRoot);
        const preserved = scenario === "helper-replaced" ? "control/recovery.mjs" : "note.txt";
        expect(
          fs.readFileSync(`${first.anchor}.superseded-${first.operationId}/${preserved}`, "utf8"),
        ).toBe("historical replacement");
      }
      const second = await prepare();
      expect(second.operationId).not.toBe(first.operationId);
      expect(openPackageActivationJournal(second.anchor).read().phase).toBe("prepared");
    },
  );
});
