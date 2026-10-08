import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openPackageActivationJournal,
  packageActivationIdentity,
  resolvePackageActivationHelper,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import { intentSchema } from "./package-update-activation-schema.js";
import {
  assertNoPendingPackageActivation,
  readPackageActivationReceipt,
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

describe.skipIf(process.platform === "win32")("completed package receipt remount", () => {
  it.each([
    "completed",
    "settled",
    "inode",
    "package-inode",
    "installation-key",
    "active",
    "non-linux",
  ] as const)(
    "admits only completed device drift, preserving %s receipt safety",
    async (scenario) => {
      const first = await prepare();
      if (scenario === "settled") {
        fs.renameSync(first.packageRoot, `${first.packageRoot}.original`);
        fs.mkdirSync(first.packageRoot, { mode: 0o700 });
        fs.writeFileSync(
          path.join(first.packageRoot, "package.json"),
          '{"name":"openclaw","version":"3.0.0"}',
        );
        await settlePendingPackageActivation(first.packageRoot);
      } else if (scenario !== "active") {
        await runPackageActivationRecovery(first.anchor, "repair", first.operationId);
        await runPackageActivationRecovery(first.anchor, "retire", first.operationId);
      }
      const record = openPackageActivationJournal(first.anchor).read();
      if (scenario === "settled" && record.intent && "replacementIdentity" in record.intent) {
        record.intent = { ...record.intent, detail: "original manual installation receipt" };
      }
      const historical = (value: unknown) =>
        JSON.stringify(value, (_key, entry: unknown) => {
          if (typeof entry !== "string" || !/^\d+:\d+$/u.test(entry)) {
            return entry;
          }
          return entry.replace(/^\d+/u, (device) => String(BigInt(device) + 1n));
        });
      const differentInode = (identity: string) =>
        identity.replace(/\d+$/u, (inode) => String(BigInt(inode) + 1n));
      if (scenario === "inode") {
        record.descriptor.journalIdentity = differentInode(record.descriptor.journalIdentity);
      } else if (scenario === "package-inode") {
        record.descriptor.previous.identity = differentInode(record.descriptor.previous.identity);
      } else if (scenario === "installation-key") {
        record.descriptor.authority.installKey = `${first.packageRoot}-other`;
      }
      const journalPath = resolvePackageActivationJournalPath(first.anchor);
      const readPersistedIntent = () => {
        const database = new DatabaseSync(journalPath, { readOnly: true });
        try {
          const row = database.prepare("SELECT intent_json FROM package_activation").get();
          return intentSchema.parse(JSON.parse(String(row?.intent_json)));
        } finally {
          database.close();
        }
      };
      const remount = (current: typeof record) => {
        const database = new DatabaseSync(journalPath);
        try {
          database
            .prepare("UPDATE package_activation SET descriptor_json = ?, intent_json = ?")
            .run(historical(current.descriptor), historical(current.intent));
        } finally {
          database.close();
        }
      };
      remount(record);
      const before = fs.readFileSync(journalPath);
      const platform = vi
        .spyOn(process, "platform", "get")
        .mockReturnValue(scenario === "non-linux" ? "darwin" : "linux");
      try {
        if (scenario !== "completed" && scenario !== "settled") {
          expect(() => assertNoPendingPackageActivation(first.packageRoot)).toThrow(
            "does not match its installation",
          );
          expect(fs.readFileSync(journalPath)).toEqual(before);
          return;
        }
        for (let reboot = 0; reboot < 2; reboot++) {
          const originalIntent = readPersistedIntent();
          expect(() => assertNoPendingPackageActivation(first.packageRoot)).not.toThrow();
          const settled = openPackageActivationJournal(first.anchor).read();
          expect(settled).toMatchObject({
            phase: scenario === "settled" ? "superseded" : "anchor-retired",
          });
          expect(readPersistedIntent()).toEqual(
            originalIntent && "replacementIdentity" in originalIntent
              ? {
                  ...originalIntent,
                  replacementIdentity: packageActivationIdentity(first.packageRoot, true),
                }
              : originalIntent,
          );
          expect(readPackageActivationReceipt(first.packageRoot)).toMatchObject({
            phase: "complete",
          });
          expect(fs.existsSync(resolvePackageActivationHelper(first.anchor))).toBe(false);
          expect(() => assertNoPendingPackageActivation(first.packageRoot)).not.toThrow();
          expect(openPackageActivationJournal(first.anchor).read()).toEqual(settled);
          if (reboot === 0) {
            remount(settled);
          }
        }
      } finally {
        platform.mockRestore();
      }
      const second = await prepare();
      expect(second.operationId).not.toBe(first.operationId);
    },
  );
});
