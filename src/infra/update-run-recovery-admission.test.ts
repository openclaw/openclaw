import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { recordConfigFileWrite } from "../config/write-capture.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import * as openClawTmpDir from "./tmp-openclaw-dir.js";
import {
  createUpdateRecoveryBackup,
  inspectUpdateRecoveryRetirements,
  preserveUpdateRecoveryCandidate,
  restoreUpdateRecoveryBackup,
  retireUpdateRecoveryBackup,
  verifyUpdateRecoveryBackup,
  writeUpdateRecoveryBackupOutcome,
} from "./update-recovery-backup.js";
import { withUpdateRecoveryConfigWrites } from "./update-recovery-config-writes.js";
import { createRetainedCheckpointFixture } from "./update-retained-checkpoint.test-support.js";
import { createUpdateRun, finishUpdateRun, getUpdateRun } from "./update-run-ledger.js";
import { assertUpdateRecoveryAdmission } from "./update-run-recovery-admission.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("package-only recovery admission", () => {
  it("admits absent state without creating it", async () => {
    const root = path.join(dirs.make("update-admission-"), "absent");
    await assertUpdateRecoveryAdmission({ env: { OPENCLAW_STATE_DIR: root } });
    expect(fsSync.existsSync(root)).toBe(false);
  });

  it.each(["sealed", "unsealed", "displaced", "orphan beside canonical"] as const)(
    "refuses %s checkpoint state without changing retained bytes",
    async (kind) => {
      const f = createRetainedCheckpointFixture(
        dirs.make("update-admission-"),
        kind !== "unsealed",
      );
      if (kind === "displaced" || kind === "orphan beside canonical") {
        f.displace();
      }
      const freshRun =
        kind === "orphan beside canonical"
          ? createUpdateRun({ trigger: "cli" }, f.options)
          : undefined;
      closeOpenClawStateDatabaseForTest();
      const files = [
        f.file,
        f.displaced,
        f.record.checkpoint!.ref.manifestPath,
        f.record.restore!.planPath,
      ];
      const snapshot = () =>
        files.map((file) => (fsSync.existsSync(file) ? fsSync.readFileSync(file) : null));
      const before = snapshot();
      await expect(assertUpdateRecoveryAdmission(f.options)).rejects.toThrow(
        /recovery|publication/i,
      );
      expect(snapshot()).toEqual(before);
      if (freshRun) {
        expect(getUpdateRun(freshRun.runId, f.options)).toEqual(freshRun);
      }
    },
  );
});

const authority = { assertOwned() {} };
async function captureAdmissionFixture(state: OpenClawTestState) {
  await state.writeConfig({ plugins: { enabled: false } });
  const installRoot = state.path("install");
  await fs.mkdir(installRoot, { mode: 0o700 });
  await fs.writeFile(path.join(installRoot, "package.json"), '{"name":"openclaw"}');
  const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
  return { ...authority, runId: run.runId, installRoot };
}

describe("transaction-scoped update capture admission", () => {
  it("preserves one unresolved capture and refuses a second protected update", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const input = await captureAdmissionFixture(state);
      const first = await createUpdateRecoveryBackup(input);
      finishUpdateRun(input.runId, { status: "failed" }, { env: state.env });
      const config = await fs.readFile(state.configPath, "utf8");
      await expect(createUpdateRecoveryBackup({ ...input, runId: randomUUID() })).rejects.toThrow(
        /another protected mutation is refused.*openclaw update status --json.*npx openclaw@latest doctor --fix/s,
      );
      await verifyUpdateRecoveryBackup(first);
      expect(await fs.readFile(state.configPath, "utf8")).toBe(config);
    });
  });

  it("publishes the terminal outcome once without replacing an earlier outcome", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const ref = await createUpdateRecoveryBackup(await captureAdmissionFixture(state));
      await writeUpdateRecoveryBackupOutcome(ref, { status: "committed" }, authority);
      const target = path.join(ref.directory, "outcome.json");
      const original = await fs.readFile(target);
      await expect(
        writeUpdateRecoveryBackupOutcome(ref, { status: "restored" }, authority),
      ).rejects.toThrow(/write-once.*already settled/);
      expect(await fs.readFile(target)).toEqual(original);
      await verifyUpdateRecoveryBackup(ref);
    });
  });

  it("keeps incomplete crash-left captures inspection-only when another update starts", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const input = await captureAdmissionFixture(state);
      const previous = `${state.stateDir}.update-captures/crash-left`;
      await fs.mkdir(previous, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(previous, "payload"), "retained crash evidence");
      await expect(createUpdateRecoveryBackup(input)).rejects.toThrow(
        /crash-left.*Inspection only/s,
      );
      expect(await fs.readFile(path.join(previous, "payload"), "utf8")).toBe(
        "retained crash evidence",
      );
    });
  });
});

async function restoreCaptureFixture(state: OpenClawTestState) {
  const coordination = state.path("coordinator");
  await fs.mkdir(coordination, { mode: 0o700 });
  vi.spyOn(openClawTmpDir, "resolvePreferredOpenClawTmpDir").mockReturnValue(coordination);
  const include = state.statePath("long-included-configuration-directory", "gateway.json5");
  await fs.mkdir(path.dirname(include), { mode: 0o700 });
  const original = '{"mode":"local"}\n';
  await fs.writeFile(include, original);
  await state.writeConfig({
    gateway: { $include: "./long-included-configuration-directory/gateway.json5" },
    plugins: { enabled: false },
  });
  const installRoot = state.path("install");
  await fs.mkdir(installRoot, { mode: 0o700 });
  const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
  const ref = await createUpdateRecoveryBackup({ ...authority, runId: run.runId, installRoot });
  return { include, original, run, ref };
}

const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");

describe("update capture recovery without rewinding the active ledger", () => {
  it.each(["running", "failed"] as const)(
    "preserves %s run receipts and authored includes across repeated publication refusal",
    async (status) => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        const { include, original, run, ref } = await restoreCaptureFixture(state);
        const migrated = '{"mode":"local","port":19123}\n';
        await withUpdateRecoveryConfigWrites(ref, authority, async () => {
          await fs.writeFile(include, migrated);
          recordConfigFileWrite(include, hash(original), hash(migrated));
        });
        if (status === "failed") {
          finishUpdateRun(run.runId, { status, reason: "synthetic-post-migration-failure" });
        }
        const receipts = getUpdateRun(run.runId)?.origin.updateRecoveryCapture;
        const baselineBytes = await fs.readFile(ref.manifestPath);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await expect(restoreUpdateRecoveryBackup(ref, authority)).rejects.toThrow(
            /Rollback publication is unavailable/,
          );
          expect(getUpdateRun(run.runId)?.origin.updateRecoveryCapture).toEqual(receipts);
          expect(getUpdateRun(run.runId)?.status).toBe(status);
          expect(await fs.readFile(include, "utf8")).toBe(migrated);
          expect(await fs.readFile(ref.manifestPath)).toEqual(baselineBytes);
          await verifyUpdateRecoveryBackup(ref);
          await verifyUpdateRecoveryBackup(await preserveUpdateRecoveryCandidate(ref, authority));
        }
        expect(getUpdateRun(run.runId)?.reason).toBe(
          status === "failed" ? "synthetic-post-migration-failure" : null,
        );
      });
    },
  );

  it.each([false, true])(
    "resumes terminal retirement after payload removal (historical sibling=%s)",
    async (historicalSibling) => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        const { ref } = await restoreCaptureFixture(state);
        const manifest = await verifyUpdateRecoveryBackup(ref);
        await writeUpdateRecoveryBackupOutcome(ref, { status: "committed" }, authority);
        const removed = manifest.entries.find((entry) => entry.kind === "file");
        if (removed?.kind !== "file") {
          throw new Error("Missing capture payload");
        }
        await fs.unlink(path.join(ref.directory, removed.archivePath));
        const evidence = path.join(path.dirname(ref.directory), "manual-retained-evidence");
        if (historicalSibling) {
          await fs.writeFile(evidence, "operator-retained evidence");
        }
        await expect(verifyUpdateRecoveryBackup(ref)).rejects.toThrow();
        await retireUpdateRecoveryBackup(ref, authority);
        await expect(fs.lstat(ref.directory)).rejects.toMatchObject({ code: "ENOENT" });
        if (historicalSibling) {
          expect(await fs.readFile(evidence, "utf8")).toBe("operator-retained evidence");
        } else {
          await expect(fs.lstat(path.dirname(ref.directory))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
      });
    },
  );

  it.each(["resume", "replacement"])(
    "handles interrupted retirement metadata deletion: %s",
    async (action) => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        const { ref } = await restoreCaptureFixture(state);
        await writeUpdateRecoveryBackupOutcome(ref, { status: "committed" }, authority);
        await expect(
          retireUpdateRecoveryBackup(ref, {
            assertOwned() {
              if (!fsSync.existsSync(ref.manifestPath)) {
                throw new Error("interrupted retirement tail");
              }
            },
          }),
        ).rejects.toThrow("interrupted retirement tail");
        await expect(fs.lstat(ref.manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect((await inspectUpdateRecoveryRetirements()).map((entry) => entry.ref)).toEqual([ref]);
        if (action === "replacement") {
          await fs.rename(ref.directory, `${ref.directory}-original`);
          await fs.mkdir(ref.directory, { mode: 0o700 });
          await expect(retireUpdateRecoveryBackup(ref, authority)).rejects.toThrow(
            "directory was replaced",
          );
          expect(await fs.readdir(ref.directory)).toEqual([]);
        } else {
          await retireUpdateRecoveryBackup(ref, authority);
          await expect(fs.lstat(ref.directory)).rejects.toMatchObject({ code: "ENOENT" });
        }
      });
    },
  );

  it("preserves a pending capture and refuses retirement after a payload disappears", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const { ref } = await restoreCaptureFixture(state);
      const manifest = await verifyUpdateRecoveryBackup(ref);
      const removed = manifest.entries.find((entry) => entry.kind === "file");
      if (removed?.kind !== "file") {
        throw new Error("Missing capture payload");
      }
      await fs.unlink(path.join(ref.directory, removed.archivePath));
      const remaining = await fs.readdir(path.join(ref.directory, "payload"));
      await expect(retireUpdateRecoveryBackup(ref, authority)).rejects.toThrow();
      expect(await fs.readdir(path.join(ref.directory, "payload"))).toEqual(remaining);
      expect(await inspectUpdateRecoveryRetirements()).toEqual([]);
      expect(await fs.readFile(ref.manifestPath, "utf8")).toContain(manifest.runId);
    });
  });
});
