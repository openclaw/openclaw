import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import { resolveManagedUpdateLeaseDatabasePath } from "./update-managed-service-handoff-lease.js";

type TriageOutcome = {
  exit: { code: number | null; signal: NodeJS.Signals | null };
  stdout: string;
  stderr: string;
};

const disappearance =
  "Automatic triage could not complete: sidecar changed during reclaim policy callback. Run `openclaw triage` manually.";
const alreadyOwned =
  "Automatic triage already owned for this installation; wait for its cleanup or inspect the saved diagnostics and run openclaw triage manually.";

export function expectTriageDenial(outcome: TriageOutcome, diagnostics = JSON.stringify(outcome)) {
  expect(outcome.exit, diagnostics).toEqual({ code: 7, signal: null });
  expect(outcome.stdout, diagnostics).toBe('{"status":"error","reason":"original"}\n');
  const lines = outcome.stderr.split("\n");
  const denials = lines.filter((line) => line === disappearance || line === alreadyOwned);
  expect(denials, diagnostics).toHaveLength(1);
  expect(
    lines.filter((line) => line.startsWith("Automatic triage could not complete:")),
    diagnostics,
  ).toEqual(denials[0] === disappearance ? [disappearance] : []);
  expect(outcome.stderr, diagnostics).not.toMatch(/\n\s+at /);
  expect(
    lines.filter((line) => line.startsWith("triage-completion:")),
    diagnostics,
  ).toEqual(["triage-completion:undefined"]);
  expect(
    (outcome.stderr.match(/Automatic triage is preparing/g) ?? []).length,
    diagnostics,
  ).toBeLessThanOrEqual(1);
  return denials[0] === disappearance;
}

export function expectTriageCompleted(outcome: TriageOutcome) {
  const diagnostics = JSON.stringify(outcome);
  expect(outcome.exit, diagnostics).toEqual({ code: 7, signal: null });
  expect(outcome.stdout, diagnostics).toBe('{"status":"error","reason":"original"}\n');
  expect(outcome.stderr.match(/triage-completion:.*/g), diagnostics).toEqual([
    "triage-completion:completed",
  ]);
  expect(outcome.stderr, diagnostics).not.toContain("already owned");
  expect(outcome.stderr, diagnostics).not.toContain("could not complete");
  expect(outcome.stderr, diagnostics).not.toMatch(/\n\s+at /);
}

export async function expectReleasedTriage(root: string, diagnostics: string) {
  const databasePath = resolveManagedUpdateLeaseDatabasePath();
  const name = path.basename(databasePath);
  const files = await fs.readdir(path.dirname(databasePath));
  expect(
    files.filter(
      (file) =>
        file.startsWith(`${name}.lock`) ||
        ["-journal", "-wal", "-shm"].some((suffix) => file === `${name}${suffix}`),
    ),
    diagnostics,
  ).toEqual([]);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    expect(db.prepare("PRAGMA quick_check").all(), diagnostics).toEqual([{ quick_check: "ok" }]);
    expect(
      db.prepare("SELECT * FROM managed_update_handoffs WHERE install_root = ?").get(root),
      diagnostics,
    ).toBeUndefined();
  } finally {
    db.close();
  }
}
