import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assert, expect, it, vi } from "vitest";
import { finishUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import * as shared from "./shared.js";
import * as execution from "./update-command-execution.js";
import {
  createSelectedTargetStateDatabase,
  installFreshUpdateFixture,
  targetDoctorSuccess,
} from "./update-command-fresh.test-support.js";
import * as packageUpdate from "./update-command-package.js";
import * as commandRun from "./update-command-run.js";
import * as servicePlan from "./update-command-service-plan.js";
import { updateCommand } from "./update-command.js";

const { fixture, dirs } = installFreshUpdateFixture();

it("fresh local artifact reaches compatible target staging without creating parent state", async () => {
  const source = dirs.make("openclaw-synthetic-artifact-");
  const packageDir = path.join(source, "package");
  fs.mkdirSync(packageDir);
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: "2026.9.2",
      engines: { node: ">=22" },
      openclaw: { schemaVersions: { state: 16, agent: 19 } },
    }),
  );
  const artifact = path.join(source, "candidate.tgz");
  execFileSync("tar", ["-czf", artifact, "-C", source, "package"]);
  vi.mocked(shared.resolveTargetVersion).mockResolvedValue(null);
  vi.mocked(packageUpdate.stagePackageInstallUpdate).mockRejectedValue(
    new Error("artifact-staged"),
  );
  const outcome = await updateCommand({
    tag: artifact,
    yes: true,
    json: true,
    restart: false,
  }).then(
    () => "completed",
    (error: unknown) => (error instanceof Error ? error.message : "unknown"),
  );
  expect(fs.existsSync(fixture.databasePath)).toBe(false);
  expect(outcome).toBe("artifact-staged");
});

it.each([
  { schema: 16, version: "2026.9.2", code: undefined },
  { schema: undefined, version: "2026.9.2", code: "target-schema-metadata" },
  { schema: 16, version: "invalid", code: "target-version-resolution" },
])(
  "inspects artifact version $version and schema $schema before canonical initialization and history",
  async ({ schema, version, code }) => {
    const candidate = dirs.make("openclaw-artifact-candidate-");
    fs.writeFileSync(
      path.join(candidate, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version,
        engines: { node: ">=22" },
        ...(schema === undefined
          ? {}
          : { openclaw: { schemaVersions: { state: schema, agent: 19 } } }),
      }),
    );
    vi.mocked(shared.resolveTargetVersion).mockResolvedValue(null);
    const staged = { root: candidate, run: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    let privateState: string | undefined;
    vi.mocked(packageUpdate.stagePackageInstallUpdate).mockImplementation(async (params) => {
      privateState = params.installEnv?.OPENCLAW_STATE_DIR;
      expect(privateState).not.toBe(process.env.OPENCLAW_STATE_DIR);
      expect(params.installEnv?.HOME).toBe(process.env.HOME);
      expect(params.managedServiceEnv?.OPENCLAW_STATE_DIR).toBe(process.env.OPENCLAW_STATE_DIR);
      expect(fs.existsSync(fixture.databasePath)).toBe(false);
      return staged;
    });
    const runtime = vi
      .spyOn(servicePlan, "resolvePackageRuntimePreflight")
      .mockResolvedValue({ ok: true, value: {} });
    const doctor = vi
      .spyOn(packageUpdate, "runPackageUpdateDoctor")
      .mockImplementation(async (params) => {
        expect(params.root).toBe(candidate);
        expect(params.managedServiceEnv?.OPENCLAW_STATE_DIR).toBe(process.env.OPENCLAW_STATE_DIR);
        expect(fs.existsSync(fixture.databasePath)).toBe(false);
        if (schema === 16) {
          createSelectedTargetStateDatabase(fixture.databasePath);
        } else {
          openOpenClawStateDatabase();
          closeOpenClawStateDatabaseForTest();
        }
        return targetDoctorSuccess;
      });
    const admission = vi
      .spyOn(commandRun, "admitUpdateCommandRun")
      .mockRejectedValue(new Error("artifact-admitted"));
    const outcome = await updateCommand({
      tag: "file:/fixture/candidate.tgz",
      yes: true,
      json: true,
      restart: false,
    }).then(
      () => "completed",
      (error: unknown) => (error instanceof Error ? error.message : "unknown"),
    );
    expect(staged.close).toHaveBeenCalledOnce();
    expect(privateState).toBeDefined();
    expect(fs.existsSync(path.dirname(privateState!))).toBe(false);
    if (code) {
      expect(doctor).not.toHaveBeenCalled();
      expect(admission).not.toHaveBeenCalled();
      expect(fs.existsSync(fixture.databasePath)).toBe(false);
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "target-metadata-preflight",
          mode: "npm",
          steps: [
            expect.objectContaining({
              failureFacts: [
                expect.objectContaining({
                  code,
                  message: expect.stringContaining("openclaw update --tag"),
                }),
              ],
            }),
          ],
        }),
      );
    } else {
      expect(outcome).toBe("artifact-admitted");
      expect(doctor).toHaveBeenCalledOnce();
      expect(runtime).toHaveBeenCalledWith(
        expect.objectContaining({ target: { version: "2026.9.2", nodeEngine: ">=22" } }),
      );
      expect(admission).toHaveBeenCalledOnce();
      const db = new DatabaseSync(fixture.databasePath, { readOnly: true });
      try {
        expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: schema });
      } finally {
        db.close();
      }
    }
  },
);

it.each(["node", "concurrent-state"] as const)(
  "refuses artifact %s incompatibility before canonical Doctor or history",
  async (fault) => {
    const candidate = dirs.make("openclaw-artifact-refusal-");
    fs.writeFileSync(
      path.join(candidate, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.9.2",
        engines: { node: ">=22" },
        openclaw: { schemaVersions: { state: 16, agent: 19 } },
      }),
    );
    vi.mocked(shared.resolveTargetVersion).mockResolvedValue(null);
    let previous: Buffer | undefined;
    const stage = { root: candidate, run: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(packageUpdate.stagePackageInstallUpdate).mockImplementation(async () => {
      if (fault === "concurrent-state") {
        openOpenClawStateDatabase();
        closeOpenClawStateDatabaseForTest();
        previous = fs.readFileSync(fixture.databasePath);
      }
      return stage;
    });
    vi.spyOn(servicePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
      ok: false,
      error: "selected artifact requires a newer Node",
    });
    const doctor = vi.spyOn(packageUpdate, "runPackageUpdateDoctor");
    const admission = vi.spyOn(commandRun, "admitUpdateCommandRun");
    await updateCommand({
      tag: "file:/fixture/candidate.tgz",
      yes: true,
      json: true,
      restart: false,
    }).catch(() => undefined);
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: fault === "node" ? "node-runtime-preflight" : "database-schema-preflight",
      }),
    );
    expect(doctor).not.toHaveBeenCalled();
    expect(admission).not.toHaveBeenCalled();
    expect(stage.run).not.toHaveBeenCalled();
    expect(stage.close).toHaveBeenCalledOnce();
    if (previous) {
      expect(fs.readFileSync(fixture.databasePath)).toEqual(previous);
    } else {
      expect(fs.existsSync(fixture.databasePath)).toBe(false);
    }
  },
);

it("requires confirmation for an inspected older artifact without a TTY", async () => {
  const candidate = dirs.make("artifact-downgrade-");
  fs.writeFileSync(
    path.join(candidate, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: "2026.9.2",
      openclaw: { schemaVersions: { state: 16, agent: 19 } },
    }),
  );
  vi.mocked(shared.resolveTargetVersion).mockResolvedValue(null);
  const stage = { root: candidate, run: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  vi.mocked(packageUpdate.stagePackageInstallUpdate).mockResolvedValue(stage);
  vi.spyOn(servicePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
    ok: true,
    value: {},
  });
  const doctor = vi
    .spyOn(packageUpdate, "runPackageUpdateDoctor")
    .mockRejectedValue(new Error("confirmation was bypassed"));
  const admission = vi.spyOn(commandRun, "admitUpdateCommandRun");
  await updateCommand({ tag: "file:/fixture/older.tgz", json: true, restart: false }).catch(
    () => undefined,
  );
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
    expect.objectContaining({ status: "skipped", reason: "downgrade-confirmation-required" }),
  );
  expect(doctor).not.toHaveBeenCalled();
  expect(admission).not.toHaveBeenCalled();
  expect(stage.close).toHaveBeenCalledOnce();
  expect(fs.existsSync(fixture.databasePath)).toBe(false);
});

it.each([OPENCLAW_STATE_SCHEMA_VERSION, OPENCLAW_STATE_SCHEMA_VERSION + 1])(
  "admits compatible parent history before artifact schema %s migration",
  async (schema) => {
    const candidate = dirs.make("artifact-forward-");
    fs.writeFileSync(
      path.join(candidate, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.9.4",
        engines: { node: ">=22" },
        openclaw: { schemaVersions: { state: schema, agent: 19 } },
      }),
    );
    vi.mocked(shared.resolveTargetVersion).mockResolvedValue(null);
    const stage = { root: candidate, run: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(packageUpdate.stagePackageInstallUpdate).mockResolvedValue(stage);
    vi.spyOn(servicePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
      ok: true,
      value: {},
    });
    const doctor = vi
      .spyOn(packageUpdate, "runPackageUpdateDoctor")
      .mockImplementation(async () => {
        openOpenClawStateDatabase();
        closeOpenClawStateDatabaseForTest();
        const db = new DatabaseSync(fixture.databasePath);
        try {
          db.exec(`PRAGMA user_version=${schema}; UPDATE schema_meta SET schema_version=${schema}`);
        } finally {
          db.close();
        }
        return targetDoctorSuccess;
      });
    const execute = vi
      .spyOn(execution, "executeMutableUpdate")
      .mockImplementation(async (params) => {
        const run = params.opts.run;
        assert(run);
        const db = new DatabaseSync(fixture.databasePath, { readOnly: true });
        try {
          expect(db.prepare("PRAGMA user_version").get()).toEqual({
            user_version: OPENCLAW_STATE_SCHEMA_VERSION,
          });
        } finally {
          db.close();
        }
        expect(getUpdateRun(run.runId, { env: run.env })?.status).toBe("running");
        finishUpdateRun(
          run.runId,
          { status: "skipped", reason: "fixture-before-forward-migration" },
          { env: run.env },
        );
        return null;
      });
    const outcome = await updateCommand({
      tag: "file:/fixture/forward.tgz",
      yes: true,
      json: true,
      restart: false,
    }).then(
      () => "admitted",
      () => "rejected",
    );
    expect(outcome).toBe("admitted");
    expect(doctor.mock.calls.length).toBe(0);
    expect(execute).toHaveBeenCalledOnce();
    expect(stage.close).toHaveBeenCalledOnce();
  },
);
