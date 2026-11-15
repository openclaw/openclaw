import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import * as durability from "./directory-durability.js";
import {
  readBytes as bytes,
  historicalJson,
  withDatabase,
} from "./package-update-activation-fixtures.test-support.js";
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
} from "./package-update-activation.js";
import { legacyPackageFingerprint } from "./package-update-legacy.test-support.js";

const settle = (f: { packageRoot: string; operationId: string }, operationId = f.operationId) =>
  settlePendingPackageActivation(f.packageRoot, undefined, undefined, { operationId });
const fixture = createPackageActivationLifetimeFixture();
const { setup, prepare, lifetime } = fixture;
const test = it.skipIf(process.platform === "win32");
let root: string;
const remounted = (
  launchers: "equal-symlinks" | "different-files" = "equal-symlinks",
  installed: "previous" | "candidate" = "candidate",
) => prepareRemountedPublication(fixture, root, false, launchers, installed);
const expectPresent = (...files: string[]) => {
  for (const file of files) {
    expect(fs.existsSync(file), file).toBe(true);
  }
};
function updateJournal(anchor: string, sql: string, ...values: Array<string | number>) {
  withDatabase(resolvePackageActivationJournalPath(anchor), (db) => db.prepare(sql).run(...values));
}
function changeIdentity(identity: string, component = /\d+$/u) {
  return identity.replace(component, (value) => String(BigInt(value) + 1n));
}
function afterLauncherSync(launcher: string, effect: () => void) {
  const sync = durability.syncDirectory;
  vi.spyOn(durability, "syncDirectory").mockImplementation(async (directory) => {
    const result = await sync(directory);
    if (directory === path.dirname(launcher)) {
      effect();
    }
    return result;
  });
}
beforeEach(() => {
  ({ root } = setup());
});
afterEach(async () => {
  try {
    await lifetime.cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

test.each([
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
] as const)("keeps %s drift historical without admitting foreign work", async (scenario) => {
  const first = await prepare();
  if (scenario === "settled-evidence") {
    fs.renameSync(first.packageRoot, `${first.packageRoot}.original`);
    fs.mkdirSync(first.packageRoot, { mode: 0o700 });
    fs.writeFileSync(
      path.join(first.packageRoot, "package.json"),
      '{"name":"openclaw","version":"3.0.0"}',
    );
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
  if (scenario === "helper-replaced") {
    fs.writeFileSync(resolvePackageActivationHelper(first.anchor), "historical replacement");
  } else if (scenario === "anchor-replaced") {
    fs.mkdirSync(first.anchor, { mode: 0o700 });
    fs.writeFileSync(path.join(first.anchor, "note.txt"), "historical replacement");
  } else if (scenario === "journal-inode") {
    record.descriptor.journalIdentity = changeIdentity(record.descriptor.journalIdentity);
  } else if (scenario === "package-inode") {
    record.descriptor.candidate.identity = changeIdentity(record.descriptor.candidate.identity);
    record.descriptor.preparation = record.descriptor.preparation.map((entry) =>
      entry.name === "candidate"
        ? { ...entry, identity: record.descriptor.candidate.identity }
        : entry,
    );
  } else if (scenario === "lease-identity") {
    record.descriptor.authority.databaseIdentity = changeIdentity(
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
    fs.rmSync(first.anchor, { recursive: true });
    fs.unlinkSync(resolvePackageActivationHelper(first.anchor));
  }
  const journalPath = resolvePackageActivationJournalPath(first.anchor);
  updateJournal(
    first.anchor,
    "UPDATE package_activation SET descriptor_json = ?, intent_json = ?",
    historicalJson(record.descriptor),
    historicalJson(record.intent),
  );
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
});
test.each([
  "prepared",
  "candidate",
  "content",
  "launcher",
  "publishing-intent",
  "publishing-launcher",
] as const)("settles only verified remounted preparation: %s", async (scenario) => {
  const f = await remounted("different-files", "previous");
  if (scenario === "candidate") {
    fs.appendFileSync(path.join(f.anchor, "candidate/openclaw.mjs"), "damaged unused candidate");
  } else if (scenario === "content") {
    fs.appendFileSync(path.join(f.packageRoot, "package.json"), " ");
  } else if (scenario === "launcher") {
    fs.appendFileSync(f.launcher, "changed");
  } else if (scenario.startsWith("publishing")) {
    updateJournal(
      f.anchor,
      "UPDATE package_activation SET phase = 'publishing', intent_json = ?, publications_json = ?",
      scenario === "publishing-intent" ? JSON.stringify({ kind: "displace" }) : "null",
      scenario === "publishing-launcher"
        ? JSON.stringify([
            { name: "openclaw", identity: f.historical.launchers[0]!.candidateIdentity },
          ])
        : "[]",
    );
  }
  const liveTree = legacyPackageFingerprint(f.packageRoot);
  const launcher = fs.readFileSync(f.launcher);
  const before = fs.readFileSync(f.journalPath);
  if (scenario === "prepared" || scenario === "candidate") {
    await expect(
      settlePendingPackageActivation(f.packageRoot, undefined, undefined, { dryRun: true }),
    ).resolves.toMatchObject({ reason: "publication-not-started" });
    expect(fs.readFileSync(f.journalPath)).toEqual(before);
    await expect(settle(f)).resolves.toMatchObject({ reason: "publication-not-started" });
    expect(fs.existsSync(f.journalPath)).toBe(false);
    expect(fs.existsSync(`${f.anchor}.superseded-${f.operationId}/candidate`)).toBe(true);
    expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
  } else {
    await expect(settle(f)).rejects.toThrow(
      scenario.startsWith("publishing")
        ? "previous package has unfinished publication"
        : /fingerprint changed|launcher changed/u,
    );
    expect(fs.readFileSync(f.journalPath)).toEqual(before);
    expect(fs.existsSync(path.join(f.anchor, "candidate"))).toBe(true);
  }
  expect(legacyPackageFingerprint(f.packageRoot)).toEqual(liveTree);
  expect(fs.readFileSync(f.launcher)).toEqual(launcher);
});

test("refuses separate-helper settlement without a remount", async () => {
  const f = await fixture.prepare();
  const journalPath = resolvePackageActivationJournalPath(f.anchor);
  const before = fs.readFileSync(journalPath);
  await expect(settle(f)).rejects.toThrow("requires a verified device remount");
  expect(fs.readFileSync(journalPath)).toEqual(before);
  expect(fs.existsSync(path.join(f.anchor, "candidate"))).toBe(true);
});

test.each(["settle", "archive-interrupted", "journal-mode"] as const)(
  "verifies and preserves the installed candidate: %s",
  async (scenario) => {
    const f = await remounted();
    if (scenario === "journal-mode") {
      fs.chmodSync(f.journalPath, 0o644);
    }
    const liveTree = legacyPackageFingerprint(f.packageRoot);
    const previousTree = legacyPackageFingerprint(path.join(f.anchor, "previous"));
    const liveBytes = bytes(f.packageRoot, "package.json");
    // Verification reads the link, which may advance its atime (Linux relatime).
    const launcherState = () => {
      const { dev, ino, mode, nlink, uid, gid, size, mtimeNs, ctimeNs } = fs.lstatSync(f.launcher, {
        bigint: true,
      });
      const target = fs.readlinkSync(f.launcher);
      return { dev, ino, mode, nlink, uid, gid, size, mtimeNs, ctimeNs, target };
    };
    const launcher = launcherState();
    const previousBytes = bytes(f.anchor, "previous/package.json");
    const helperBytes = fs.readFileSync(resolvePackageActivationHelper(f.anchor));
    const before = fs.readFileSync(f.journalPath);
    expect(() =>
      openPackageActivationSettlementJournal(f.anchor).readForAdmission(f.packageRoot),
    ).toThrow("does not match its installation");
    expect(() => assertNoPendingPackageActivation(f.packageRoot)).toThrow(
      "does not match its installation",
    );
    const identities: [string, string, string][] = [
      ["parent", f.historical.parentIdentity, path.dirname(f.anchor)],
      [
        "control dir",
        f.historical.journalParentIdentity,
        resolvePackageActivationControl(f.anchor),
      ],
      ["journal", f.historical.journalIdentity, f.journalPath],
    ];
    const bindings = identities.map(([name, recorded, file]) => {
      const current = fs.lstatSync(file, { bigint: true });
      return `${name} (recorded ${recorded}; current ${current.dev}:${current.ino}; device number changed only)`;
    });
    expect(() => readPackageActivationReceipt(f.packageRoot)).toThrow(
      `Package publication journal does not match its installation: ${bindings.join("; ")}. Run openclaw update repair.`,
    );
    await expect(readPackageActivationStatus(f.anchor, f.operationId)).rejects.toThrow(
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
    const result =
      scenario === "settle" ? await settlePendingPackageActivation(f.packageRoot) : await settle(f);
    expect(result).toMatchObject({ reason: "publication-settled-external-change" });
    cut?.mockRestore();
    if (scenario === "archive-interrupted") {
      const closed = openPackageActivationJournal(f.anchor).read();
      expect(closed.phase).toBe("superseded");
      await settlePendingPackageActivation(f.packageRoot, undefined, closed);
    }
    const retained = `${f.anchor}.superseded-${f.operationId}`;
    withDatabase(
      path.join(retained, "control/operation.sqlite"),
      (db) => {
        const row = db.prepare("SELECT * FROM package_activation").get()!;
        expect(row.phase).toBe("superseded");
        expect(JSON.parse(String(row.intent_json))).toMatchObject({
          kind: "publication-settled-external-change",
          settled: true,
        });
        expect(JSON.parse(String(row.descriptor_json))).toEqual(f.historical);
      },
      true,
    );
    expect(legacyPackageFingerprint(f.packageRoot)).toEqual(liveTree);
    expect(legacyPackageFingerprint(path.join(retained, "previous"))).toEqual(previousTree);
    expect(bytes(f.packageRoot, "package.json")).toEqual(liveBytes);
    expect(launcherState()).toEqual(launcher);
    expect(bytes(retained, "previous/package.json")).toEqual(previousBytes);
    expect(bytes(retained, "control/recovery.mjs")).toEqual(helperBytes);
    expect(fs.statSync(path.join(retained, "control/operation.sqlite")).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(f.journalPath)).toBe(false);
    expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
  },
);

test.each(["before-commit", "before-archive"] as const)(
  "refuses settlement after ownership reassignment: %s",
  async (scenario) => {
    const f = await remounted();
    const before = fs.readFileSync(f.journalPath);
    const reassign = () => {
      withDatabase(f.historical.authority.databasePath, (lease) => {
        const { changes } = lease
          .prepare("UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?")
          .run(randomUUID(), f.packageRoot);
        expect(changes).toBe(1);
      });
    };
    if (scenario === "before-commit") {
      // Reassign after the full-tree verification, at the launcher sync before the close.
      afterLauncherSync(f.launcher, reassign);
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
    const refusal = await settle(f).then(
      () => undefined,
      (error: unknown) => error,
    );
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
    expect(fs.existsSync(`${f.anchor}.superseded-${f.operationId}`)).toBe(false);
    expectPresent(
      resolvePackageActivationControl(f.anchor),
      path.join(f.anchor, "previous"),
      f.packageRoot,
    );
  },
);

test.each([
  "content",
  "after-verification",
  "metadata",
  "launcher",
  "rewritten-original-launcher",
  "inode",
  "device-map",
  "journal-inode",
  "journal-device-map",
  "helper",
  "journal-hardlink",
  "operation",
  "active-lease",
  "rollback",
] as const)("refuses %s without closing or replacing anything", async (scenario) => {
  const f = await remounted(
    scenario === "rewritten-original-launcher" ? "different-files" : "equal-symlinks",
  );
  if (scenario === "rewritten-original-launcher") {
    const before = fs.lstatSync(f.launcher, { bigint: true });
    fs.writeFileSync(f.launcher, bytes(f.anchor, "launchers/openclaw"));
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
    afterLauncherSync(f.launcher, () => {
      fs.appendFileSync(path.join(f.packageRoot, "openclaw.mjs"), "changed after verification");
    });
  }
  if (scenario === "launcher") {
    fs.unlinkSync(f.launcher);
    fs.symlinkSync("other-target", f.launcher);
  }
  if (scenario === "helper") {
    fs.appendFileSync(resolvePackageActivationHelper(f.anchor), "changed");
  }
  if (scenario === "journal-hardlink") {
    fs.linkSync(f.journalPath, `${f.journalPath}.link`);
  }
  if (
    ["inode", "device-map", "journal-inode", "journal-device-map", "rollback"].includes(scenario)
  ) {
    const d = structuredClone(f.historical);
    if (scenario !== "rollback") {
      const field = scenario.startsWith("journal-") ? "journalIdentity" : "binIdentity";
      const part = scenario.endsWith("inode") ? /\d+$/u : /^\d+/u;
      d[field] = changeIdentity(d[field], part);
    }
    updateJournal(
      f.anchor,
      "UPDATE package_activation SET descriptor_json = ?, phase = ?",
      JSON.stringify(d),
      scenario === "rollback" ? "rollback-in-progress" : "publishing",
    );
  }
  const before = fs.readFileSync(f.journalPath);
  const refuse = () =>
    expect(settle(f, scenario === "operation" ? randomUUID() : f.operationId)).rejects.toThrow();
  if (scenario === "active-lease") {
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      await executor.enter(f.packageRoot);
      await refuse();
    });
  } else {
    await refuse();
  }
  expect(fs.readFileSync(f.journalPath)).toEqual(before);
  expectPresent(path.join(f.anchor, "previous"), f.packageRoot);
});
