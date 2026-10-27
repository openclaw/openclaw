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
import { createUpdateRun, finishUpdateRun } from "../../infra/update-run-ledger.js";
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
  writeFixtureJsonSync(
    path.join(directory, "manifest.json"),
    createMissingConfigRecoveryManifest({
      runId,
      installRoot: root,
      stateDir: path.dirname(root),
      configPath: path.join(root, "config.json"),
      createdAt,
    }),
  );
  return directory;
}

/** Finished updates, one failed baseline, the latest update, a live run, and unattributed entries. */
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
    for (const [label, status, sealed] of [
      ["superseded", "succeeded", true],
      ["unsealed", "failed", false],
      ["alreadyCurrent", "skipped", true],
      ["failedBaseline", "failed", true],
      ["latest", "succeeded", false],
      ["unfinished", undefined, true],
    ] as const) {
      clock.mockReturnValue((now += 60_000));
      const { runId } = createUpdateRun({ trigger: "cli" }, { env });
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

async function runCleanup(options: { dryRun?: boolean; yes?: boolean }) {
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
    reason: "awaiting-later-completed-update",
    bytes: 1035,
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
      expect(progress).toHaveLength(3);
      for (const [index, text] of progress.entries()) {
        expect(text).toMatch(
          new RegExp(`^Removing capture ${index + 1}/3: .+ \\(103[58] bytes\\)\\n$`),
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
