import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import {
  openPackageActivationJournal,
  resolvePackageActivationHelper,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import {
  assertNoPendingPackageActivation,
  runPackageActivationRecovery,
  settlePendingPackageActivation,
} from "./package-update-activation.js";
import { legacyPackageFingerprint } from "./package-update-legacy.test-support.js";

// Keep real helper hashing and custody, using the shared inert helper's known digest.
vi.mock("./package-update-activation-paths.js", async (original) => ({
  ...(await original<typeof import("./package-update-activation-paths.js")>()),
  LEGACY_PACKAGE_RECOVERY_HELPER:
    "12de0cc399fbbb4d93ab30ac67817b0a48ab73682df7477e944f9186d8e22c1e",
}));

const fixtures = createPackageActivationLifetimeFixture();
beforeEach(() => {
  fixtures.setup();
});
afterEach(async () => {
  await fixtures.lifetime.cleanup();
  vi.restoreAllMocks();
});

it.skipIf(process.platform === "win32").each([
  { phase: "aborted", action: "retire" },
  { phase: "aborted", action: "repair" },
  { phase: "aborted", action: "public repair" },
  { phase: "publishing", action: "repair" },
] as const)(
  "settles the legacy $phase record through $action after link-count drift",
  async ({ phase, action }) => {
    const f = await fixtures.prepare();
    const journal = openPackageActivationJournal(f.anchor);
    const helper = fs.readFileSync(resolvePackageActivationHelper(f.anchor));
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(f.packageRoot);
      const record = journal.read();
      journal.transition(
        record,
        phase,
        phase === "publishing" ? { kind: "publish" } : null,
        fence.assertCurrent,
        [],
      );
      const db = new DatabaseSync(resolvePackageActivationJournalPath(f.anchor));
      try {
        db.prepare("UPDATE package_activation SET descriptor_json = ?").run(
          JSON.stringify({
            ...record.descriptor,
            previous: legacyPackageFingerprint(f.packageRoot),
            candidate: legacyPackageFingerprint(path.join(f.anchor, "candidate")),
          }),
        );
      } finally {
        db.close();
      }
      if (phase === "publishing") {
        fs.renameSync(f.packageRoot, path.join(f.anchor, "previous"));
      }
    });
    const previous = phase === "publishing" ? path.join(f.anchor, "previous") : f.packageRoot;
    const manifest = path.join(previous, "package.json");
    const before = fs.statSync(manifest, { bigint: true });
    const link = path.join(path.dirname(f.anchor), "retention-link");
    fs.linkSync(manifest, link);
    expect(fs.statSync(manifest, { bigint: true }).nlink).toBe(before.nlink + 1n);

    const reported = vi.fn();
    if (action === "public repair") {
      await expect(settlePendingPackageActivation(f.packageRoot, reported)).resolves.toMatchObject({
        detail:
          "legacy package record settled by identity and version; content could not be re-verified",
      });
      expect(reported).toHaveBeenCalledWith(
        expect.objectContaining({
          detail:
            "legacy package record settled by identity and version; content could not be re-verified",
        }),
      );
    } else {
      await expect(
        runPackageActivationRecovery(f.anchor, action, f.operationId),
      ).resolves.toMatchObject({ phase: "complete" });
    }
    expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
    expect(
      JSON.parse(fs.readFileSync(path.join(f.packageRoot, "package.json"), "utf8")).version,
    ).toBe(phase === "publishing" ? "2.0.0" : "1.0.0");
    const retained = `${f.anchor}.superseded-${f.operationId}`;
    expect(fs.readFileSync(path.join(retained, "control/recovery.mjs"))).toEqual(helper);
    const db = new DatabaseSync(path.join(retained, "control/operation.sqlite"), {
      readOnly: true,
    });
    try {
      const row = db.prepare("SELECT phase, intent_json FROM package_activation").get();
      expect(row?.phase).toBe("superseded");
      expect(JSON.parse(String(row?.intent_json))).toMatchObject({
        settled: true,
        detail:
          "legacy package record settled by identity and version; content could not be re-verified",
      });
    } finally {
      db.close();
    }
  },
);
