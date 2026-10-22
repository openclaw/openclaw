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
import {
  resultFixture,
  stepFixture,
  verificationFixture,
} from "./update-command-fixtures.test-support.js";
import { UpdateCommandPendingRecoveryFailure } from "./update-command-result.js";
import { captureUpdateCommandTerminalRecord } from "./update-command-terminal-record.js";
import { resolveSettledUpdateCommandResult } from "./update-command-terminal.js";
import { publishUpdateCommandTerminalResultForTest as publishUpdateCommandTerminalResult } from "./update-command-terminal.test-support.js";

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
  recordUpdateRunVerification(runId, verificationFixture(after.version, after.buildId), { env });
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
  const result = resultFixture(root, { mode: "git", runId, after, durationMs: 1 });
  return {
    params,
    run,
    result,
    release: () => {
      current = false;
    },
    databasePath: resolveOpenClawStateSqlitePath(env),
    write(sql: string, ...values: (string | number)[]) {
      const db = new DatabaseSync(resolveOpenClawStateSqlitePath(env));
      try {
        db.prepare(sql).run(...values);
      } finally {
        db.close();
      }
    },
    capture: (candidate = result) =>
      captureUpdateCommandTerminalRecord(params, candidate, assertCurrent),
    settle: (
      candidate = result,
      captured?: Awaited<ReturnType<typeof captureUpdateCommandTerminalRecord>>,
      error?: Error,
    ) => resolveSettledUpdateCommandResult(params, candidate, error, captured),
  };
}

function setVerification(f: ReturnType<typeof fixture>, key: string, value: unknown) {
  const remove = value === undefined;
  f.write(
    `UPDATE update_runs SET verification_json = ${remove ? "json_remove(verification_json, ?)" : "json_set(verification_json, ?, json(?))"} WHERE run_id = ?`,
    `$.${key}`,
    ...(remove ? [] : [JSON.stringify(value)]),
    f.run.runId,
  );
}

type CaptureRejection = {
  name: string;
  terminal?: "running" | "failed";
  committed?: UpdateRunResult["after"];
  expected?: UpdateRunResult["after"];
  verification?: [key: string, value: unknown];
};

const verificationRejections: [string, string, unknown, UpdateRunResult["after"]?][] = [
  ["missing observed build", "runningBuildId", undefined],
  ["missing observed version", "runningVersion", undefined, { version: after.version }],
  ["conflicting omitted build", "runningBuildId", "unrelated-build", { version: after.version }],
  ["conflicting omitted version", "runningVersion", "2026.1.1", { buildId: after.buildId }],
  ["missing plugin error list", "pluginErrors", undefined],
  ["plugin failure", "pluginErrors", ["synthetic plugin failure"]],
];

const captureRejections: CaptureRejection[] = [
  ...["serviceRunning", "versionMatch", "channelsReady", "readyz", "settled"].map<CaptureRejection>(
    (key) => ({ name: `unverified ${key}`, verification: [key, false] }),
  ),
  ...verificationRejections.map<CaptureRejection>(([name, key, value, expected]) => ({
    name,
    expected,
    verification: [key, value],
  })),
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
      expect(await f.capture()).toBeUndefined();
    },
  );

  it("preserves the ordinary readiness-pending report without a captured success", async () => {
    const f = fixture();
    const pending = normalizeControlPlaneUpdateResult({
      ...f.result,
      steps: [
        stepFixture("gateway verification", {
          command: "openclaw gateway status",
          cwd: root,
          durationMs: 1,
          exitCode: 0,
          termination: "timeout",
          advisory: { kind: "recoverable-maintenance", message: "Gateway is still starting" },
        }),
      ],
    });
    const captured = await f.capture(pending);
    expect(captured).toBeUndefined();
    const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    const settled = await f.settle(pending, captured);
    const reported = await publishUpdateCommandTerminalResult(f.params, settled.result, {
      rolledBack: false,
    });
    expect(reported).toMatchObject({ status: "skipped", reason: "gateway-readiness-unverified" });
    expect(output).toHaveBeenCalledTimes(1);
  });

  it("publishes the durable verified build without snapshots when history omits its Git SHA", async () => {
    const f = fixture();
    f.result.after = { ...after, sha: "a".repeat(40) };
    const captured = await f.capture();
    expect(captured?.record.after).toEqual(after);
    expect(captured?.record.status).toBe("succeeded");
    const before = fs.readFileSync(f.databasePath);
    f.release();
    const takeSnapshot = vi
      .spyOn(snapshot, "prepareSqliteReadOnlyLocationSync")
      .mockImplementation(() => {
        throw new Error("live database is changing");
      });
    const reportPath = path.join(root, "update-reports", `${f.run.runId}.md`);
    let savedAtPublication: string | undefined;
    const captureReport = () => {
      savedAtPublication ??= fs.readFileSync(reportPath, "utf8");
    };
    const jsonOutput = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(captureReport);
    const settled = await f.settle(f.result, captured);
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
    await expect(assertUpdateRecoveryAdmission({ env: f.run.env })).rejects.toThrow(
      "live database is changing",
    );
  });

  it.each([
    "failed cleanup",
    "retarget",
    "replace",
    "different-run",
    "different-candidate",
  ] as const)("refuses a captured result after %s", async (kind) => {
    const f = fixture();
    const captured = await f.capture();
    f.release();
    let cleanupError: Error | undefined;
    if (kind === "failed cleanup") {
      cleanupError = new Error("release failed");
    } else if (kind === "retarget") {
      f.run.env.OPENCLAW_STATE_DIR = dirs.make("update-terminal-other-");
    } else if (kind === "replace") {
      fs.renameSync(f.databasePath, `${f.databasePath}.retained`);
      fs.copyFileSync(`${f.databasePath}.retained`, f.databasePath);
    } else if (kind === "different-run") {
      f.run.runId = "unrelated-run";
    } else {
      f.result.after = { ...after, buildId: "different-candidate" };
    }
    await expect(f.settle(f.result, captured, cleanupError)).rejects.toBeInstanceOf(
      UpdateCommandPendingRecoveryFailure,
    );
  });

  it("keeps genuine retained recovery with its existing finalizer", async () => {
    const retained = createRetainedCheckpointFixture(root);
    const f = fixture(retained.run.runId);
    const captured = await f.capture();
    expect(captured).toBeUndefined();
    await expect(f.settle()).rejects.toBeInstanceOf(UpdateCommandPendingRecoveryFailure);
  });

  it.each(["malformed recovery", "interrupted publication", "closed executor"])(
    "rejects capture after %s",
    async (condition) => {
      const f = fixture();
      if (condition === "malformed recovery") {
        f.write(
          "INSERT INTO config_machine_state(state_key, value_json, updated_at_ms) VALUES(?, ?, ?)",
          `update.recovery.${f.run.runId}`,
          "{}",
          Date.now(),
        );
        await expect(f.capture()).rejects.toThrow();
      } else if (condition === "interrupted publication") {
        fs.mkdirSync(path.join(path.dirname(f.databasePath), ".openclaw-restore-synthetic"));
        await expect(f.capture()).rejects.toThrow("Interrupted shared-database publication");
      } else {
        f.release();
        await expect(f.capture()).rejects.toThrow("synthetic executor closed");
      }
    },
  );
});
