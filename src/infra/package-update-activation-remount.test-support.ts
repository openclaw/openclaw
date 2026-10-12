import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import {
  openPackageActivationJournal,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import { createPackageIntegrityReader } from "./package-update-integrity.js";
import { legacyPackageFingerprint } from "./package-update-legacy.test-support.js";

/** Synthetic lost publish acknowledgement; the original launcher already names the candidate. */
export async function prepareRemountedPublication(
  fixture: ReturnType<typeof createPackageActivationLifetimeFixture>,
  root: string,
  legacy = false,
  launchers: "equal-symlinks" | "different-files" = "equal-symlinks",
) {
  const prepared = await fixture.prepare(async () => {
    const stage = path.join(root, "stage/lib/node_modules/openclaw");
    fs.writeFileSync(
      path.join(stage, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.9.9",
        type: "module",
        bin: { openclaw: "./openclaw.mjs" },
      }),
    );
    fs.mkdirSync(path.join(stage, "dist"), { recursive: true });
    fs.writeFileSync(path.join(stage, "dist/build-info.json"), '{"version":"2026.9.9"}');
    fs.writeFileSync(path.join(stage, "openclaw.mjs"), "// candidate launcher target\n");
    await writePackageDistInventory(stage);
    for (const prefix of launchers === "equal-symlinks" ? ["live", "stage"] : []) {
      const launcher = path.join(root, prefix, "bin/openclaw");
      fs.unlinkSync(launcher);
      fs.symlinkSync("../lib/node_modules/openclaw/openclaw.mjs", launcher);
    }
  });
  const journal = openPackageActivationJournal(prepared.anchor);
  const initial = journal.read();
  const candidate = path.join(prepared.anchor, "candidate");
  const actualDevice = String(fs.statSync(candidate, { bigint: true }).dev);
  const historicalDevice = String(BigInt(actualDevice) + 1000n);
  const tree = legacy
    ? legacyPackageFingerprint(candidate, historicalDevice)
    : await createPackageIntegrityReader().tree(
        candidate,
        initial.descriptor.originalStageRoot,
        undefined,
        false,
        new Map([[actualDevice, historicalDevice]]),
      );
  journal.transition(initial, "publishing", { kind: "publish" }, () => {});
  fs.renameSync(prepared.packageRoot, path.join(prepared.anchor, "previous"));
  fs.renameSync(candidate, prepared.packageRoot);
  const record = journal.read();
  if (!("digest" in record.descriptor.candidate)) {
    throw new Error("Fixture requires a full candidate fingerprint.");
  }
  record.descriptor.candidate.digest = tree.digest;
  const historical = JSON.stringify(record.descriptor, (_key, value: unknown) =>
    typeof value === "string" && /^\d+:\d+$/u.test(value)
      ? value.replace(/^\d+/u, (device) => String(BigInt(device) + 1000n))
      : value,
  );
  const journalPath = resolvePackageActivationJournalPath(prepared.anchor);
  const db = new DatabaseSync(journalPath);
  try {
    db.prepare("UPDATE package_activation SET descriptor_json = ?, revision = 35").run(historical);
  } finally {
    db.close();
  }
  return {
    ...prepared,
    journalPath,
    historical: JSON.parse(historical) as typeof record.descriptor,
  };
}
