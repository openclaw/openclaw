import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createMissingConfigRecoveryManifest } from "../../commands/update-recovery-manifest.test-support.js";
import { resolveUpdateCaptureRoot } from "../../infra/update-capture-paths.js";
import {
  UPDATE_CAPTURE_PRIVACY_MARKER,
  UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
} from "../../infra/update-capture-privacy-marker.js";
import { inspectUpdateRecoveryBackups } from "../../infra/update-recovery-backup-status.js";
import { retainedCheckpointBinding } from "../../infra/update-retained-checkpoint.test-support.js";
import {
  createRetainedUpdateRecovery,
  storeRetainedUpdateRecovery,
} from "../../infra/update-retained-recovery.test-support.js";
import {
  createUpdateRun,
  finishUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunRepairAttempt,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { writeFixtureJsonSync } from "../cli-fixtures.test-support.js";
import { updateCleanupCommand } from "./cleanup.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await cleanupSessionStateForTest();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

function writeCapture(root: string, name: string, sealed: boolean, marked = true): string {
  const directory = path.join(root, name);
  fs.mkdirSync(path.join(directory, "payload"), { recursive: true });
  fs.mkdirSync(path.join(directory, "database.databases"));
  if (marked) {
    fs.writeFileSync(
      path.join(directory, UPDATE_CAPTURE_PRIVACY_MARKER),
      UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
    );
  }
  fs.writeFileSync(path.join(directory, "payload", "0"), Buffer.alloc(1000));
  if (sealed) {
    fs.writeFileSync(path.join(directory, "manifest.json"), "{}\n");
  }
  return directory;
}

function writeSealedCapture(root: string, runId: string, createdAt: string): string {
  const directory = writeCapture(root, runId, true);
  const stateDir = root.slice(0, -".update-captures".length);
  writeFixtureJsonSync(
    path.join(directory, "manifest.json"),
    createMissingConfigRecoveryManifest({
      runId,
      installRoot: root,
      stateDir,
      configPath: path.join(stateDir, "openclaw.json"),
      createdAt,
    }),
  );
  return directory;
}

/** Finished updates, activated and never-activated failures, a live run, and unattributed entries. */
async function withCaptureHistory(
  run: (captures: Record<string, string>, root: string) => Promise<void>,
  location: "current" | "pre-migration",
) {
  // Both current and pre-migration captures are siblings of their state directories.
  const home = fs.realpathSync(dirs.make("update-capture-cleanup-"));
  const stateDir = path.join(home, ".openclaw");
  fs.mkdirSync(stateDir);
  const env = {
    HOME: home,
    OPENCLAW_HOME: undefined,
    OPENCLAW_PROFILE: undefined,
    OPENCLAW_STATE_DIR: undefined,
    OPENCLAW_CONFIG_PATH: undefined,
  };
  await withEnvAsync(env, async () => {
    const root = resolveUpdateCaptureRoot(
      location === "pre-migration" ? path.join(home, ".clawdbot") : stateDir,
    );
    fs.mkdirSync(root);
    fs.writeFileSync(
      path.join(root, UPDATE_CAPTURE_PRIVACY_MARKER),
      UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
    );
    const clock = vi.spyOn(Date, "now");
    const captures: Record<string, string> = {};
    let now = Date.UTC(2026, 8, 30);
    const activated = ["staging", "validating", "activating"] as const;
    for (const [label, status, sealed, phases, repaired, captured = true] of [
      ["superseded", "succeeded", true, activated],
      ["unsealed", "failed", false, activated],
      ["alreadyCurrent", "skipped", true, []],
      ["failedBaseline", "failed", true, activated],
      ["latest", "succeeded", false, activated],
      // Later than every successful update: only the missing activation releases it.
      ["neverActivated", "failed", true, ["staging", "validating"]],
      ["repairedBeforeActivation", "failed", true, ["staging", "validating"], true],
      // Runs that took no original-state capture (finalize, repair) never qualify.
      ["uncapturedBeforeActivation", "failed", true, ["staging", "validating"], false, false],
      ["unfinished", undefined, true, []],
    ] as const) {
      clock.mockReturnValue((now += 60_000));
      const { runId } = createUpdateRun({ trigger: "cli" }, { env });
      if (captured) {
        recordUpdateRunStep(
          runId,
          { step: "original-state-capture", status: "completed" },
          { env },
        );
      }
      for (const phase of phases) {
        recordUpdateRunPhase(runId, phase, {}, { env });
      }
      if (repaired) {
        recordUpdateRunRepairAttempt(
          runId,
          { attempt: 1, status: "failed", startedAtMs: now, endedAtMs: now },
          { env },
        );
      }
      if (status === "succeeded") {
        recordUpdateRunVerification(
          runId,
          {
            serviceRunning: true,
            versionMatch: true,
            settled: true,
            coreReady: true,
            pluginErrors: [],
          },
          { env },
        );
      }
      if (status) {
        clock.mockReturnValue((now += 60_000));
        finishUpdateRun(runId, { status }, { env });
      }
      captures[label] = writeCapture(root, runId, sealed);
    }
    clock.mockRestore();
    captures.orphan = writeSealedCapture(root, randomUUID(), "2026-10-13T10:00:00.000Z");
    captures.incomplete = writeSealedCapture(root, randomUUID(), "2026-10-13T10:00:00.000Z");
    fs.writeFileSync(path.join(captures.incomplete, "manifest.json.partial"), "pending");
    captures.unattributed = writeCapture(root, "doctor-unrecorded", true);
    captures.unmarked = writeCapture(root, "c0ffee00-0000-4000-8000-000000000000", true, false);
    closeOpenClawStateDatabaseForTest();
    await run(captures, root);
  });
}

async function runCleanup(options: {
  dryRun?: boolean;
  yes?: boolean;
  includeUnmanifested?: string[];
}) {
  const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
  await updateCleanupCommand({ ...options, json: true });
  expect(exit).not.toHaveBeenCalled();
  const report = writeJson.mock.calls.at(-1)?.[0] as {
    status: string;
    artifacts: Array<{
      kind?: string;
      path: string;
      outcome: string;
      reason: string;
      bytes: number;
    }>;
  };
  return {
    status: report.status,
    captures: Object.fromEntries(
      report.artifacts
        .filter((item) => item.kind === "update-capture")
        .map((item) => [
          item.path,
          { outcome: item.outcome, reason: item.reason, bytes: item.bytes },
        ]),
    ),
  };
}

const expectedPreview = (captures: Record<string, string>) => ({
  [captures.superseded!]: {
    outcome: "candidate",
    reason: "superseded-update-capture",
    bytes: 1038,
  },
  [captures.unsealed!]: { outcome: "candidate", reason: "unsealed-update-capture", bytes: 1035 },
  [captures.alreadyCurrent!]: {
    outcome: "candidate",
    reason: "superseded-update-capture",
    bytes: 1038,
  },
  [captures.failedBaseline!]: {
    outcome: "protected",
    reason: "unresolved-failed-update",
    bytes: 1038,
  },
  [captures.latest!]: {
    outcome: "protected",
    reason: "awaiting-later-verified-update",
    bytes: 1035,
  },
  [captures.neverActivated!]: {
    outcome: "candidate",
    reason: "never-activated-update-capture",
    bytes: 1038,
  },
  [captures.repairedBeforeActivation!]: {
    outcome: "protected",
    reason: "unresolved-failed-update",
    bytes: 1038,
  },
  [captures.uncapturedBeforeActivation!]: {
    outcome: "protected",
    reason: "unresolved-failed-update",
    bytes: 1038,
  },
  [captures.unfinished!]: { outcome: "protected", reason: "unfinished-update-run", bytes: 1038 },
  [captures.orphan!]: {
    outcome: "protected",
    reason: "orphan-update-capture",
    bytes: expect.any(Number),
  },
  [captures.incomplete!]: {
    outcome: "protected",
    reason: "unmanifested-update-capture",
    bytes: expect.any(Number),
  },
  [captures.unattributed!]: {
    outcome: "protected",
    reason: "unmanifested-update-capture",
    bytes: 1038,
  },
  [captures.unmarked!]: {
    outcome: "protected",
    reason: "unmanifested-update-capture",
    bytes: 1003,
  },
});

it.each(["current", "pre-migration"] as const)(
  "previews %s update captures with their classification and bytes without removing them",
  async (location) => {
    await withCaptureHistory(async (captures) => {
      const preview = await runCleanup({ dryRun: true });
      expect(preview).toEqual({ status: "preview", captures: expectedPreview(captures) });
      for (const directory of Object.values(captures)) {
        expect(fs.existsSync(directory)).toBe(true);
      }
    }, location);
  },
);

it.each(["current", "pre-migration"] as const)(
  "removes only %s candidate captures and keeps protected captures",
  async (location) => {
    await withCaptureHistory(async (captures, root) => {
      using stderr = vi.spyOn(process.stderr, "write").mockImplementation((text) => {
        if (!String(text).startsWith("Removing capture ")) {
          return true;
        }
        const directory = Object.values(captures).find((item) => String(text).includes(item));
        expect(directory).toBeDefined();
        expect(fs.existsSync(directory!)).toBe(true);
        return true;
      });
      const result = await runCleanup({ yes: true });
      expect(result.status).toBe("complete");
      const progress = stderr.mock.calls
        .map(([text]) => String(text))
        .filter((text) => text.startsWith("Removing capture "));
      expect(progress).toHaveLength(4);
      for (const [index, text] of progress.entries()) {
        expect(text).toMatch(
          new RegExp(`^Removing capture ${index + 1}/4: .+ \\(103[58] bytes\\)\\n$`),
        );
      }
      const preview = expectedPreview(captures);
      for (const [directory, item] of Object.entries(preview)) {
        expect(result.captures[directory]).toEqual(
          item.outcome === "candidate"
            ? { outcome: "removed", reason: "update-capture-retired", bytes: item.bytes }
            : item,
        );
        expect(fs.existsSync(directory)).toBe(item.outcome !== "candidate");
      }
      expect(fs.existsSync(path.join(root, UPDATE_CAPTURE_PRIVACY_MARKER))).toBe(true);
    }, location);
  },
);

it.each(["current", "pre-migration"] as const)(
  "lists standalone Doctor captures and retires only older %s captures through cleanup",
  async (location) => {
    await withCaptureHistory(async (_captures, root) => {
      const now = Date.now();
      const doctors = [5, 4, 3, 2, 1].map((age) => {
        const runId = `doctor-${randomUUID()}`;
        return writeSealedCapture(root, runId, new Date(now - age * 86_400_000).toISOString());
      });
      const preview = await runCleanup({ dryRun: true });
      for (const [index, directory] of doctors.entries()) {
        expect(preview.captures[directory]).toMatchObject({
          outcome: index < 2 ? "candidate" : "protected",
          reason: index < 2 ? "superseded-doctor-capture" : "retained-doctor-capture",
        });
        expect(preview.captures[directory]!.bytes).toBeGreaterThan(1000);
        expect(fs.existsSync(directory)).toBe(true);
      }
      await runCleanup({ yes: true });
      expect(doctors.map((directory) => fs.existsSync(directory))).toEqual([
        false,
        false,
        true,
        true,
        true,
      ]);
    }, location);
  },
);

it("reclaims historical incomplete captures only after a verified successor and agrees with status", async () => {
  await withCaptureHistory(async (_captures, root) => {
    const historical = writeCapture(root, `doctor-${randomUUID()}`, false);
    const orphan = writeSealedCapture(root, randomUUID(), "2026-08-01T00:00:00.000Z");
    const doctors = [40, 39].map((age) =>
      writeSealedCapture(
        root,
        `doctor-${randomUUID()}`,
        new Date(Date.now() - age * 86_400_000).toISOString(),
      ),
    );
    fs.writeFileSync(path.join(historical, "manifest.json.partial"), "interrupted seal");
    for (const directory of [historical, orphan]) {
      fs.utimesSync(directory, new Date("2026-10-20"), new Date("2026-10-20"));
    }
    const { runId } = createUpdateRun({ trigger: "cli" });
    finishUpdateRun(runId, { status: "succeeded" });
    expect((await runCleanup({ dryRun: true })).captures[historical]).toMatchObject({
      outcome: "protected",
    });
    // A status label without recorded readiness cannot retire the only possible original.
    await runCleanup({ yes: true });
    expect(fs.existsSync(historical)).toBe(true);
    recordUpdateRunVerification(runId, {
      serviceRunning: true,
      versionMatch: true,
      settled: true,
      coreReady: true,
      pluginErrors: [],
    });
    const preview = await runCleanup({ dryRun: true });
    expect(preview.captures[historical]).toMatchObject({
      outcome: "protected",
      reason: "superseded-unsealed-capture",
    });
    expect(preview.captures[orphan]).toMatchObject({
      outcome: "protected",
      reason: "orphan-update-capture",
    });
    // The older expired Doctor original retired above; the newest sealed copy stays.
    expect(fs.existsSync(doctors[0]!)).toBe(false);
    expect(preview.captures[doctors[1]!]).toMatchObject({
      outcome: "protected",
      reason: "retained-doctor-capture",
    });
    const sets = await inspectUpdateRecoveryBackups();
    for (const directory of [historical, orphan]) {
      expect(sets).toContainEqual(
        expect.objectContaining({
          directory,
          status: "warning",
          nextAction: `openclaw update cleanup --dry-run --include-unmanifested "${directory}"`,
        }),
      );
      expect(fs.existsSync(directory)).toBe(true);
    }
    const selection = [historical, orphan];
    const selected = await runCleanup({ dryRun: true, includeUnmanifested: selection });
    for (const directory of selection) {
      expect(selected.captures[directory]).toMatchObject({ outcome: "candidate" });
      expect(fs.existsSync(directory)).toBe(true);
    }
    await runCleanup({ yes: true, includeUnmanifested: selection });
    expect([historical, orphan].map((directory) => fs.existsSync(directory))).toEqual([
      false,
      false,
    ]);
    expect(fs.existsSync(doctors[1]!)).toBe(true);
    expect(await inspectUpdateRecoveryBackups()).not.toContainEqual(
      expect.objectContaining({ directory: historical }),
    );
    const referenced = writeCapture(root, randomUUID(), false);
    fs.utimesSync(referenced, new Date("2026-10-20"), new Date("2026-10-20"));
    const runtime = { root, nodePath: process.execPath, version: "1.0.0", buildId: null };
    const pending = createRetainedUpdateRecovery({
      runId: randomUUID(),
      from: runtime,
      to: runtime,
    });
    pending.checkpoint = retainedCheckpointBinding(pending);
    pending.checkpoint.ref.manifestPath = path.join(referenced, "manifest.json");
    storeRetainedUpdateRecovery(pending, {});
    await runCleanup({ yes: true });
    expect(fs.existsSync(referenced)).toBe(true);
    await updateCleanupCommand({ yes: true, json: true, includeUnmanifested: [referenced] });
    expect(defaultRuntime.writeJson).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "blocked" }),
      2,
    );
    expect(fs.existsSync(referenced)).toBe(true);
  }, "current");
});
