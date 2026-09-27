import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  listUpdateRuns,
} from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { classifyUpdateOutcome } from "../../shared/update-outcome.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { VERSION } from "../../version.js";
import { updateFinalizeCommand } from "./update-command-finalize.js";
import * as finalizationDoctor from "./update-command-fresh-doctor.js";
import * as pluginUpdate from "./update-command-plugins.js";
import { admitUpdateCommandRun } from "./update-command-run.js";
import * as sourceRuntime from "./update-command-runtime.js";
import { updateCommand } from "./update-command.js";
import { UpdateFinalizationLifecycle } from "./update-finalization-lifecycle.js";
import { updateRepairCommand } from "./update-repair-command.js";

const fixture = vi.hoisted(() => ({ root: "", serviceMutation: vi.fn() }));
vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    readCommand: async () => null,
    stop: fixture.serviceMutation,
    start: fixture.serviceMutation,
    restart: fixture.serviceMutation,
    install: fixture.serviceMutation,
  }),
}));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  resolveUpdateRoot: async () => fixture.root,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function state() {
  fixture.serviceMutation.mockClear();
  fixture.root = dirs.make("update-contention-");
  vi.stubEnv("OPENCLAW_STATE_DIR", fixture.root);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(fixture.root, "openclaw.json"));
  vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", undefined);
  vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", undefined);
  vi.stubEnv("OPENCLAW_POST_CORE_UPDATE", undefined);
  fs.writeFileSync(
    path.join(fixture.root, "package.json"),
    JSON.stringify({ name: "openclaw", version: VERSION }),
  );
  const previous = createUpdateRun({ trigger: "cli" });
  finishUpdateRun(previous.runId, { status: "succeeded" });
  const before = getUpdateRun(previous.runId);
  closeOpenClawStateDatabaseForTest();
  return { filename: resolveOpenClawStateSqlitePath(), before };
}

it.each(["dry-run", "update", "repair"] as const)(
  "admits %s after a writer exceeds the general SQLite wait",
  async (mode) => {
    const { filename, before } = state();
    const writer = new Worker(
      `
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData);
    db.exec('BEGIN IMMEDIATE');
    parentPort.postMessage('locked');
    setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, 6_000);
  `,
      { eval: true, workerData: filename, execArgv: [] },
    );
    try {
      await once(writer, "message");
      const runId =
        mode === "repair"
          ? new UpdateFinalizationLifecycle(true, undefined, () => {}).attachLedger(true)
          : (
              await admitUpdateCommandRun({
                opts: { dryRun: mode === "dry-run" },
                root: fixture.root,
              })
            ).runId;
      expect(getUpdateRun(runId)).toMatchObject({ status: "running" });
      expect(getUpdateRun(before!.runId)).toEqual(before);
    } finally {
      await writer.terminate();
    }
  },
  20_000,
);

it.each(["dry-run", "update", "repair", "finalize"] as const)(
  "reports exhausted %s admission as recoverable and preserves history",
  async (mode) => {
    const { filename, before } = state();
    const writer = new DatabaseSync(filename);
    const json = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const publication = vi.spyOn(sourceRuntime, "completeSourceUpdateRuntime");
    const doctor = vi.spyOn(finalizationDoctor, "runUpdateFinalizationDoctorInFreshProcess");
    const plugins = vi.spyOn(pluginUpdate, "updatePluginsAfterCoreUpdate");
    writer.exec("BEGIN IMMEDIATE");
    try {
      const opts = { yes: true, json: true, timeout: "1" };
      await expect(
        mode === "finalize"
          ? updateFinalizeCommand(opts)
          : mode === "repair"
            ? updateRepairCommand(opts)
            : updateCommand({ ...opts, dryRun: mode === "dry-run" }),
      ).rejects.toMatchObject({ name: "ExitError", code: mode === "finalize" ? 1 : 0 });
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "skipped",
          reason: "update-ledger-busy",
          notes: [expect.stringContaining("busy")],
        }),
      );
      const result = json.mock.calls.at(-1)?.[0];
      expect(result).not.toHaveProperty("runId");
      expect(result).not.toHaveProperty("postUpdate");
      expect(publication).not.toHaveBeenCalled();
      expect(doctor).not.toHaveBeenCalled();
      expect(plugins).not.toHaveBeenCalled();
      expect(fixture.serviceMutation).not.toHaveBeenCalled();
      if (mode === "finalize") {
        expect(result).toMatchObject({ mode: "finalize" });
      }
      if (mode === "dry-run") {
        expect(result).toMatchObject({ dryRun: true, notes: [expect.stringContaining("busy")] });
      }
      expect(classifyUpdateOutcome({ status: "skipped", reason: "update-ledger-busy" })).toBe(
        "noop",
      );
      expect(listUpdateRuns()).toEqual([before]);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  },
);
