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

describe("owned completed update publication", () => {
  it.each(["serviceRunning", "versionMatch", "channelsReady", "readyz", "settled"] as const)(
    "does not capture a completed row with unverified %s",
    async (key) => {
      const f = fixture();
      setVerification(f, key, false);
      expect(
        await captureUpdateCommandTerminalRecord(f.params, f.result, f.assertCurrent),
      ).toBeUndefined();
    },
  );

  it("requires the observed build ID when an expected build ID is supplied", async () => {
    const f = fixture();
    setVerification(f, "runningBuildId", undefined);
    expect(
      await captureUpdateCommandTerminalRecord(f.params, f.result, f.assertCurrent),
    ).toBeUndefined();
  });

  it("requires the observed version when no expected build ID is supplied", async () => {
    const f = fixture();
    f.result.after = { version: after.version };
    setVerification(f, "runningVersion", undefined);
    expect(
      await captureUpdateCommandTerminalRecord(f.params, f.result, f.assertCurrent),
    ).toBeUndefined();
  });

  it.each([
    { expected: { version: after.version }, key: "runningBuildId", value: "unrelated-build" },
    { expected: { buildId: after.buildId }, key: "runningVersion", value: "2026.1.1" },
  ])(
    "rejects committed-versus-observed conflict when the result omits $key",
    async ({ expected, key, value }) => {
      const f = fixture();
      f.result.after = expected;
      setVerification(f, key, value);
      expect(
        await captureUpdateCommandTerminalRecord(f.params, f.result, f.assertCurrent),
      ).toBeUndefined();
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
    const captured = await captureUpdateCommandTerminalRecord(f.params, pending, f.assertCurrent);
    expect(captured).toBeUndefined();
    const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    const settled = await resolveSettledUpdateCommandResult(f.params, pending, undefined, captured);
    const reported = await publishUpdateCommandTerminalResult(f.params, settled.result, {
      rolledBack: false,
    });
    expect(reported).toMatchObject({ status: "skipped", reason: "gateway-readiness-unverified" });
    expect(output).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, ["synthetic plugin failure"]])(
    "does not capture a completed row without an explicit empty plugin error list: %j",
    async (pluginErrors) => {
      const f = fixture();
      setVerification(f, "pluginErrors", pluginErrors);
      expect(
        await captureUpdateCommandTerminalRecord(f.params, f.result, f.assertCurrent),
      ).toBeUndefined();
    },
  );

  it.each(["running", "failed"] as const)(
    "does not prepare %s history as completed success",
    async (status) => {
      const f = fixture(undefined, status);
      expect(
        await captureUpdateCommandTerminalRecord(f.params, f.result, f.assertCurrent),
      ).toBeUndefined();
    },
  );

  it.each(["buildId", "sha"] as const)(
    "does not replace a missing expected %s with version equality",
    async (key) => {
      const f = fixture(undefined, "succeeded", { version: after.version });
      f.result.after = { version: after.version, [key]: "expected-candidate-identity" };
      expect(
        await captureUpdateCommandTerminalRecord(f.params, f.result, f.assertCurrent),
      ).toBeUndefined();
    },
  );

  it("accepts the exact verified build when Gateway history omits its Git SHA", async () => {
    const f = fixture();
    f.result.after = { ...after, sha: "a".repeat(40) };
    expect(
      (await captureUpdateCommandTerminalRecord(f.params, f.result, f.assertCurrent))?.record.after,
    ).toEqual(after);
  });
  it("publishes the durable result without reopening snapshots", async () => {
    const f = fixture();
    const captured = await captureUpdateCommandTerminalRecord(f.params, f.result, f.assertCurrent);
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
    const captured = await captureUpdateCommandTerminalRecord(f.params, f.result, f.assertCurrent);
    f.release();
    await expect(
      resolveSettledUpdateCommandResult(f.params, f.result, new Error("release failed"), captured),
    ).rejects.toBeInstanceOf(UpdateCommandPendingRecoveryFailure);
  });

  it.each(["retarget", "replace", "different-run", "different-candidate"] as const)(
    "refuses a captured result after %s",
    async (kind) => {
      const f = fixture();
      const captured = await captureUpdateCommandTerminalRecord(
        f.params,
        f.result,
        f.assertCurrent,
      );
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
    const captured = await captureUpdateCommandTerminalRecord(f.params, f.result, f.assertCurrent);
    expect(captured).toBeUndefined();
    await expect(resolveSettledUpdateCommandResult(f.params, f.result)).rejects.toBeInstanceOf(
      UpdateCommandPendingRecoveryFailure,
    );
  });

  it("does not capture malformed recovery as an empty namespace", async () => {
    const f = fixture();
    const db = new DatabaseSync(f.databasePath);
    try {
      db.prepare(
        "INSERT INTO config_machine_state(state_key, value_json, updated_at_ms) VALUES(?, ?, ?)",
      ).run(`update.recovery.${f.params.opts.run.runId}`, "{}", Date.now());
    } finally {
      db.close();
    }
    await expect(
      captureUpdateCommandTerminalRecord(f.params, f.result, f.assertCurrent),
    ).rejects.toThrow();
  });

  it("rejects interrupted database publication before opening state", async () => {
    const f = fixture();
    fs.mkdirSync(path.join(path.dirname(f.databasePath), ".openclaw-restore-synthetic"));
    await expect(
      captureUpdateCommandTerminalRecord(f.params, f.result, f.assertCurrent),
    ).rejects.toThrow("Interrupted shared-database publication");
  });

  it("cannot prepare a receipt after its executor closes", async () => {
    const f = fixture();
    f.release();
    await expect(
      captureUpdateCommandTerminalRecord(f.params, f.result, f.assertCurrent),
    ).rejects.toThrow("synthetic executor closed");
  });
});
