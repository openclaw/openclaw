import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { runUpdateCandidateSnapshotWorker } from "./update-candidate-state.test-support.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});
let root: string;
beforeEach(async () => {
  root = await fs.realpath(dirs.make("candidate-policy-"));
});
function runSnapshotWorker(
  input: Omit<Parameters<typeof runUpdateCandidateSnapshotWorker>[0], "candidateRoot">,
) {
  return runUpdateCandidateSnapshotWorker({
    ...input,
    candidateRoot: path.join(root, "candidate-host"),
  });
}

it.each(["", ".doctor-importing"])(
  "rehearses conflicting exec approvals from the copied policy%s without modifying source",
  async (suffix) => {
    const source = path.join(root, "source");
    const target = path.join(root, "copy");
    const env = { OPENCLAW_STATE_DIR: source };
    const { writeExecApprovalsConfigRow, readExecApprovalsConfigRow } =
      await import("./exec-approvals-sqlite.js");
    const { detectLegacyExecApprovals, migrateLegacyExecApprovals } =
      await import("./state-migrations.exec-approvals.js");
    const canonical = { version: 1 as const, defaults: { security: "deny" as const }, agents: {} };
    const db = openOpenClawStateDatabase({ env }).db;
    writeExecApprovalsConfigRow({ db, file: canonical });
    const canonicalBefore = readExecApprovalsConfigRow(db)?.raw_json;
    closeOpenClawStateDatabaseForTest();
    const sourcePath = path.join(source, `exec-approvals.json${suffix}`);
    const raw = JSON.stringify({ version: 1, defaults: { security: "full" }, agents: {} });
    await fs.writeFile(sourcePath, raw);
    await runSnapshotWorker({ stateDir: source, targetStateDir: target, config: {} });
    const copiedPath = path.join(target, `exec-approvals.json${suffix}`);
    expect(await fs.readFile(copiedPath, "utf8")).toBe(raw);
    const copiedEnv = { OPENCLAW_STATE_DIR: target };
    const result = await migrateLegacyExecApprovals({
      stateDir: target,
      env: copiedEnv,
      detected: detectLegacyExecApprovals({ stateDir: target, doctorOnlyStateMigrations: true }),
    });
    expect(result.warnings.join(" ")).toContain("Conflicting legacy exec approvals remain");
    expect(result.changes).toEqual([]);
    expect(await fs.readFile(sourcePath, "utf8")).toBe(raw);
    expect(readExecApprovalsConfigRow(openOpenClawStateDatabase({ env }).db)?.raw_json).toBe(
      canonicalBefore,
    );
  },
);

it.each(["reappeared", "interrupted"])(
  "rehearses receipt-authorized legacy policy cleanup (%s)",
  async (sourceState) => {
    const source = path.join(root, "source");
    const target = path.join(root, "copy");
    const env = { OPENCLAW_STATE_DIR: source };
    const { writeExecApprovalsConfigRow } = await import("./exec-approvals-sqlite.js");
    const { detectLegacyExecApprovals, migrateLegacyExecApprovals } =
      await import("./state-migrations.exec-approvals.js");
    await fs.mkdir(source);
    const sourcePath = path.join(source, "exec-approvals.json");
    const interrupted = sourceState === "interrupted";
    const raw = JSON.stringify(
      interrupted
        ? {
            version: 1,
            agents: { main: { allowlist: [{ pattern: "/usr/bin/rg", lastUsedAt: null }] } },
          }
        : { version: 1, defaults: { security: "full" }, agents: {} },
    );
    await fs.writeFile(sourcePath, raw);
    const imported = await migrateLegacyExecApprovals({
      stateDir: source,
      env,
      detected: detectLegacyExecApprovals({ stateDir: source, doctorOnlyStateMigrations: true }),
      ...(interrupted
        ? {
            removeSource: () => {
              throw new Error("synthetic interrupted cleanup");
            },
          }
        : {}),
    });
    if (interrupted) {
      expect(imported.warnings.join(" ")).toContain("cleanup failed");
    } else {
      expect(imported.warnings).toEqual([]);
      expect(imported.changes.length).toBeGreaterThan(0);
      writeExecApprovalsConfigRow({
        db: openOpenClawStateDatabase({ env }).db,
        file: { version: 1, defaults: { security: "deny" }, agents: {} },
      });
    }
    closeOpenClawStateDatabaseForTest();
    // A reappearing imported source cannot undo a later policy edit.
    if (!interrupted) {
      await fs.writeFile(sourcePath, raw);
    }
    await runSnapshotWorker({ stateDir: source, targetStateDir: target, config: {} });
    const result = await migrateLegacyExecApprovals({
      stateDir: target,
      env: { OPENCLAW_STATE_DIR: target },
      detected: detectLegacyExecApprovals({ stateDir: target, doctorOnlyStateMigrations: true }),
    });
    expect(result.warnings).toEqual([]);
    if (interrupted) {
      expect(result.changes).toContain(
        "Completed cleanup for previously imported legacy exec approvals.",
      );
      await expect(
        fs.stat(path.join(target, "exec-approvals.json.doctor-importing")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(result.changes.length).toBeGreaterThan(0);
    }
    expect(
      await fs.readFile(`${sourcePath}${interrupted ? ".doctor-importing" : ""}`, "utf8"),
    ).toBe(raw);
  },
);
