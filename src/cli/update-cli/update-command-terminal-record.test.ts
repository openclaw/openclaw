import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as snapshot from "../../infra/sqlite-snapshot-source.js";
import { normalizeControlPlaneUpdateResult } from "../../infra/update-restart-sentinel-payload.js";
import { createRetainedCheckpointFixture } from "../../infra/update-retained-checkpoint.test-support.js";
import {
  createUpdateRun,
  finishUpdateRun,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { UpdateCommandOptions } from "./shared.js";
import { UpdateCommandPendingRecoveryFailure } from "./update-command-result.js";
import { captureUpdateCommandTerminalRecord } from "./update-command-terminal-record.js";
import {
  publishUpdateCommandTerminalResult,
  resolveSettledUpdateCommandResult,
} from "./update-command-terminal.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const after = { version: "2026.9.5", buildId: "synthetic-verified-candidate" };
let root: string;
beforeEach(() => {
  root = dirs.make("update-terminal-record-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function fixture(
  existingRunId?: string,
  terminal: "succeeded" | "failed" | "running" = "succeeded",
  committedAfter: UpdateRunResult["after"] = after,
) {
  const env = { ...process.env };
  const runId = existingRunId ?? createUpdateRun({ trigger: "cli" }, { env }).runId;
  recordUpdateRunVerification(
    runId,
    {
      serviceRunning: true,
      versionMatch: true,
      channelsReady: true,
      readyz: true,
      settled: true,
      pluginErrors: [],
      runningVersion: after.version,
      runningBuildId: after.buildId,
    },
    { env },
  );
  if (terminal !== "running") {
    finishUpdateRun(runId, { status: terminal, after: committedAfter }, { env });
  }
  closeOpenClawStateDatabaseForTest();
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("synthetic executor closed");
    }
  };
  const run: NonNullable<UpdateCommandOptions["run"]> = {
    runId,
    env,
    executorFence: { assertCurrent },
  };
  const params = { opts: { run, json: true }, root };
  const result: UpdateRunResult = {
    status: "ok",
    mode: "git",
    root,
    runId,
    after,
    steps: [],
    durationMs: 1,
  };
  return {
    params,
    result,
    assertCurrent,
    release: () => {
      current = false;
    },
    databasePath: resolveOpenClawStateSqlitePath(env),
  };
}

function setVerification(f: ReturnType<typeof fixture>, key: string, value: unknown) {
  const db = new DatabaseSync(f.databasePath);
  try {
    if (value === undefined) {
      db.prepare(
        "UPDATE update_runs SET verification_json = json_remove(verification_json, ?) WHERE run_id = ?",
      ).run(`$.${key}`, f.result.runId!);
    } else {
      db.prepare(
        "UPDATE update_runs SET verification_json = json_set(verification_json, ?, json(?)) WHERE run_id = ?",
      ).run(`$.${key}`, JSON.stringify(value), f.result.runId!);
    }
  } finally {
    db.close();
  }
}

function capture(f: ReturnType<typeof fixture>, result = f.result) {
  return captureUpdateCommandTerminalRecord(f.params, result, f.assertCurrent);
}

type CaptureRejection = {
  name: string;
  terminal?: "running" | "failed";
  committed?: UpdateRunResult["after"];
  expected?: UpdateRunResult["after"];
  verification?: [key: string, value: unknown];
};

const captureRejections: CaptureRejection[] = [
  ...["serviceRunning", "versionMatch", "channelsReady", "readyz", "settled"].map<CaptureRejection>(
    (key) => ({ name: `unverified ${key}`, verification: [key, false] }),
  ),
  { name: "missing observed build", verification: ["runningBuildId", undefined] },
  {
    name: "missing observed version",
    expected: { version: after.version },
    verification: ["runningVersion", undefined],
  },
  {
    name: "conflicting build omitted from result",
    expected: { version: after.version },
    verification: ["runningBuildId", "unrelated-build"],
  },
  {
    name: "conflicting version omitted from result",
    expected: { buildId: after.buildId },
    verification: ["runningVersion", "2026.1.1"],
  },
  { name: "missing plugin error list", verification: ["pluginErrors", undefined] },
  { name: "plugin failure", verification: ["pluginErrors", ["synthetic plugin failure"]] },
  { name: "running history", terminal: "running" },
  { name: "failed history", terminal: "failed" },
  ...["buildId", "sha"].map<CaptureRejection>((key) => ({
    name: `missing committed ${key}`,
    committed: { version: after.version },
    expected: { version: after.version, [key]: "expected-candidate-identity" },
  })),
];

describe("owned completed update publication", () => {
  it.each(captureRejections)(
    "does not capture success with $name",
    async ({ terminal, committed, expected, verification }) => {
      const f = fixture(undefined, terminal, committed);
      f.result.after = expected ?? after;
      if (verification) {
        setVerification(f, ...verification);
      }
      expect(await capture(f)).toBeUndefined();
    },
  );

  it("preserves the ordinary readiness-pending report without a captured success", async () => {
    const f = fixture();
    const pending = normalizeControlPlaneUpdateResult({
      ...f.result,
      steps: [
        {
          name: "gateway verification",
          command: "openclaw gateway status",
          cwd: root,
          durationMs: 1,
          exitCode: 0,
          termination: "timeout",
          advisory: { kind: "recoverable-maintenance", message: "Gateway is still starting" },
        },
      ],
    });
    const captured = await capture(f, pending);
    expect(captured).toBeUndefined();
    const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    const settled = await resolveSettledUpdateCommandResult(f.params, pending, undefined, captured);
    const reported = await publishUpdateCommandTerminalResult(f.params, settled.result, {
      rolledBack: false,
    });
    expect(reported).toMatchObject({ status: "skipped", reason: "gateway-readiness-unverified" });
    expect(output).toHaveBeenCalledTimes(1);
  });

  it("publishes the durable verified build without snapshots when history omits its Git SHA", async () => {
    const f = fixture();
    f.result.after = { ...after, sha: "a".repeat(40) };
    const captured = await capture(f);
    expect(captured?.record.after).toEqual(after);
    expect(captured?.record.status).toBe("succeeded");
    const before = fs.readFileSync(f.databasePath);
    f.release();
    const takeSnapshot = vi
      .spyOn(snapshot, "prepareSqliteReadOnlyLocationSync")
      .mockImplementation(() => {
        throw new Error("live database is changing");
      });
    const reportPath = path.join(root, "update-reports", `${f.params.opts.run.runId}.md`);
    let savedAtPublication: string | undefined;
    const captureReport = () => {
      savedAtPublication ??= fs.readFileSync(reportPath, "utf8");
    };
    const jsonOutput = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(captureReport);
    const settled = await resolveSettledUpdateCommandResult(
      f.params,
      f.result,
      undefined,
      captured,
    );
    const result = await publishUpdateCommandTerminalResult(f.params, settled.result, {
      rolledBack: false,
      captured: settled.captured,
    });
    expect(result.status).toBe("ok");
    expect(savedAtPublication).toContain(after.version);
    expect(takeSnapshot).not.toHaveBeenCalled();
    expect(fs.readFileSync(f.databasePath)).toEqual(before);
    expect(jsonOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ok",
        reportPath,
        run: expect.objectContaining({ status: "succeeded" }),
      }),
    );
    expect(jsonOutput.mock.calls[0]?.[0]).not.toHaveProperty("captured");
    // A historical report is not permission for the next update to skip admission.
    await expect(assertUpdateRecoveryAdmission({ env: f.params.opts.run.env })).rejects.toThrow(
      "live database is changing",
    );
  });

  it("does not let a prepared success mask failed executor cleanup", async () => {
    const f = fixture();
    const captured = await capture(f);
    f.release();
    await expect(
      resolveSettledUpdateCommandResult(f.params, f.result, new Error("release failed"), captured),
    ).rejects.toBeInstanceOf(UpdateCommandPendingRecoveryFailure);
  });

  it.each(["retarget", "replace", "different-run", "different-candidate"] as const)(
    "refuses a captured result after %s",
    async (kind) => {
      const f = fixture();
      const captured = await capture(f);
      f.release();
      if (kind === "retarget") {
        f.params.opts.run.env.OPENCLAW_STATE_DIR = dirs.make("update-terminal-other-");
      } else if (kind === "replace") {
        fs.renameSync(f.databasePath, `${f.databasePath}.retained`);
        fs.copyFileSync(`${f.databasePath}.retained`, f.databasePath);
      } else if (kind === "different-run") {
        f.params.opts.run.runId = "unrelated-run";
      } else {
        f.result.after = { ...after, buildId: "different-candidate" };
      }
      await expect(
        resolveSettledUpdateCommandResult(f.params, f.result, undefined, captured),
      ).rejects.toBeInstanceOf(UpdateCommandPendingRecoveryFailure);
    },
  );

  it("keeps genuine retained recovery with its existing finalizer", async () => {
    const retained = createRetainedCheckpointFixture(root);
    const f = fixture(retained.run.runId);
    const captured = await capture(f);
    expect(captured).toBeUndefined();
    await expect(resolveSettledUpdateCommandResult(f.params, f.result)).rejects.toBeInstanceOf(
      UpdateCommandPendingRecoveryFailure,
    );
  });

  it.each(["malformed recovery", "interrupted publication", "closed executor"])(
    "rejects capture after %s",
    async (condition) => {
      const f = fixture();
      if (condition === "malformed recovery") {
        const db = new DatabaseSync(f.databasePath);
        try {
          db.prepare(
            "INSERT INTO config_machine_state(state_key, value_json, updated_at_ms) VALUES(?, ?, ?)",
          ).run(`update.recovery.${f.params.opts.run.runId}`, "{}", Date.now());
        } finally {
          db.close();
        }
        await expect(capture(f)).rejects.toThrow();
      } else if (condition === "interrupted publication") {
        fs.mkdirSync(path.join(path.dirname(f.databasePath), ".openclaw-restore-synthetic"));
        await expect(capture(f)).rejects.toThrow("Interrupted shared-database publication");
      } else {
        f.release();
        await expect(capture(f)).rejects.toThrow("synthetic executor closed");
      }
    },
  );
});
