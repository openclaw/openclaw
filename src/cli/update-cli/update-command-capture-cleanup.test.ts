import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
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

/** Finished updates, one failed baseline, the latest update, a live run, and unattributed entries. */
async function withCaptureHistory(
  run: (captures: Record<string, string>, root: string) => Promise<void>,
) {
  // The capture root is a sibling of the state directory; keep both under one tracked parent.
  const stateDir = path.join(fs.realpathSync(dirs.make("update-capture-cleanup-")), "state");
  fs.mkdirSync(stateDir);
  const env = { OPENCLAW_STATE_DIR: stateDir };
  await withEnvAsync(
    { ...env, OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json") },
    async () => {
      const root = resolveUpdateCaptureRoot(stateDir);
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
      captures.unattributed = writeCapture(root, "doctor-unrecorded", true);
      captures.unmarked = writeCapture(root, "c0ffee00-0000-4000-8000-000000000000", true, false);
      closeOpenClawStateDatabaseForTest();
      await run(captures, root);
    },
  );
}

async function runCleanup(options: { dryRun?: boolean; yes?: boolean }) {
  const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
  await updateCleanupCommand({ ...options, json: true });
  expect(exit).not.toHaveBeenCalled();
  const report = writeJson.mock.calls[0]?.[0] as {
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

it("previews update captures with their classification and bytes without removing them", async () => {
  await withCaptureHistory(async (captures) => {
    const preview = await runCleanup({ dryRun: true });
    expect(preview).toEqual({ status: "preview", captures: expectedPreview(captures) });
    for (const directory of Object.values(captures)) {
      expect(fs.existsSync(directory)).toBe(true);
    }
  });
});

it("removes only candidate captures and keeps latest, unfinished, and unattributed ones", async () => {
  await withCaptureHistory(async (captures, root) => {
    const result = await runCleanup({ yes: true });
    expect(result.status).toBe("complete");
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
  });
});
