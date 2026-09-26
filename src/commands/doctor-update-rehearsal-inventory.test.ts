import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi, type MockInstance } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as entrypoint from "../daemon/gateway-entrypoint.js";
import * as packageRoot from "../infra/openclaw-root.js";
import * as snapshots from "../infra/update-candidate-rehearsal.js";
import * as updateCheck from "../infra/update-check.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import * as drivers from "../infra/update-run-driver.js";
import { createUpdateRun, recordUpdateRunStep } from "../infra/update-run-ledger.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import type { PluginDoctorStateMigration } from "../plugins/doctor-contract-module.js";
import * as commands from "../process/exec.js";
import { defaultRuntime } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as databasePreflight from "./doctor-database-preflight.js";
import * as workshop from "./doctor-update-rehearsal-workshop.js";
import {
  preflightUpdateDoctorCli,
  rehearseDeferredUpdateDoctorSchema,
} from "./doctor-update-schema-guard.js";

const selection = vi.hoisted(() => ({
  entries: [] as { pluginId: string; migration: PluginDoctorStateMigration }[],
}));
vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => {
  const registry = await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>();
  const { collectPluginDoctorMigrationResources } =
    await import("../plugins/doctor-migration-resources.js");
  return {
    ...registry,
    collectPluginDoctorMigrationBackupResources: (
      params: Parameters<typeof registry.collectPluginDoctorMigrationBackupResources>[0],
    ) => collectPluginDoctorMigrationResources(selection.entries, params),
  };
});
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  selection.entries = [];
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture(
  run: (f: {
    root: string;
    external: string;
    configPath: string;
    statePath: string;
    env: NodeJS.ProcessEnv;
    runtime: {
      log: ReturnType<typeof vi.fn>;
      error: ReturnType<typeof vi.fn>;
      exit: ReturnType<typeof vi.fn>;
    };
    launch: MockInstance<typeof commands.runUtf8CommandWithTimeout>;
    cleanup: ReturnType<typeof vi.fn>;
    invoke: () => Promise<void>;
    schemas: databasePreflight.DoctorDatabasePreflight;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (source) => {
    const driver = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } });
    recordUpdateRunStep(driver.runId, { step: "openclaw doctor", status: "in_progress" });
    closeOpenClawStateDatabaseForTest();
    const root = fs.realpathSync(dirs.make("openclaw-update-canary-"));
    const external = fs.realpathSync(dirs.make("rehearsal-external-"));
    fs.writeFileSync(path.join(external, "retained.txt"), "external acknowledged data", {
      mode: 0o600,
    });
    fs.mkdirSync(path.join(root, "state"), { mode: 0o700 });
    fs.mkdirSync(path.join(root, "workspace"), { mode: 0o700 });
    const statePath = path.join(root, "state", "openclaw.sqlite");
    fs.copyFileSync(resolveOpenClawStateSqlitePath(source.env), statePath);
    fs.chmodSync(statePath, 0o600);
    const configPath = path.join(root, "openclaw.json");
    const workspace = path.join(root, "workspace");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: {
          defaults: { workspace, cwd: workspace, heartbeat: { every: "0m" } },
          entries: {},
        },
        logging: { file: path.join(root, "canary.log") },
        gateway: {
          mode: "local",
          bind: "loopback",
          port: 12345,
          auth: { mode: "token", token: "00000000-0000-4000-8000-000000000000" },
          tls: { enabled: false },
          tailscale: { mode: "off" },
          controlUi: { enabled: false },
        },
        cron: { enabled: false, triggers: { enabled: false } },
        hooks: { enabled: false, internal: { enabled: false } },
        transcripts: { enabled: false, autoStart: [] },
        discovery: { mdns: { mode: "off" } },
      }),
      { mode: 0o600 },
    );
    const bytes = fs.statSync(statePath).size;
    const env = {
      ...buildUpdateRehearsalPathEnv(root),
      ...buildUpdateDoctorEnv({
        allowGatewayServiceRepair: false,
        allowGatewayActivation: false,
        serviceRepairPolicy: "external",
        deferConfiguredPluginInstallRepair: true,
      }),
    };
    const cleanup = vi.fn(async (assertDirectoryCurrent?: (directory: string) => void) => {
      assertDirectoryCurrent?.(root);
      fs.rmSync(root, { recursive: true, force: true });
    });
    vi.spyOn(packageRoot, "resolveOpenClawPackageRoot").mockResolvedValue(source.root);
    vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockResolvedValue("package");
    vi.spyOn(entrypoint, "resolveGatewayInstallEntrypoint").mockResolvedValue(
      path.join(source.root, "not-executed.js"),
    );
    // The copied-state producer and child process are controlled boundaries. The
    // caller, inventory, filesystem guards, native state reads and collector run.
    vi.spyOn(snapshots, "prepareUpdateCandidateRehearsal").mockResolvedValue({
      stateDir: root,
      configPath,
      workspaceDir: workspace,
      env,
      port: 12345,
      snapshotCapacity: {
        reason: "explicit-tmpdir",
        sqliteBytes: bytes,
        pluginBytes: 0,
        requiredBytes: bytes,
        candidates: [],
        selection: { kind: "explicit-tmpdir", directory: root },
      },
      cleanupDirectories: [root],
      cleanup,
    });
    const launch = vi.spyOn(commands, "runUtf8CommandWithTimeout").mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
      signal: null,
      killed: false,
      termination: "exit",
      cleanup: "normal",
    });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const schemas: databasePreflight.DoctorDatabasePreflight = {
      updateSchemaRehearsal: { runId: driver.runId, updaterVersion: "2026.9.2" },
      incompatible: [],
      indeterminate: [],
    };
    await run({
      schemas,
      root,
      external,
      configPath,
      statePath,
      env,
      runtime,
      launch,
      cleanup,
      invoke: () => rehearseDeferredUpdateDoctorSchema(schemas, runtime),
    });
    expect(fs.readFileSync(path.join(external, "retained.txt"), "utf8")).toBe(
      "external acknowledged data",
    );
  });
}
function migration(
  id: string,
  collectBackupResources?: PluginDoctorStateMigration["collectBackupResources"],
) {
  return {
    id,
    label: id,
    ...(collectBackupResources ? { collectBackupResources } : {}),
    detectLegacyState: vi.fn(() => null),
    migrateLegacyState: vi.fn(() => ({ changes: [], warnings: [] })),
  };
}

it("consumes declared paths, admits legacy plugins with one typed reported warning, and never detects or migrates during inventory", async () => {
  await fixture(async (f) => {
    const legacy = migration("old");
    const declared = migration("declared", (params) => {
      expect(params.requireLocalResources).toBe(true);
      expect(params.stateDir).toBe(f.root);
      expect(params.config.agents?.defaults?.workspace).toBe(path.join(f.root, "workspace"));
      return [
        { path: path.join(f.root, "plugin.sqlite"), kind: "sqlite" },
        { path: path.join(f.root, "future", "destination"), kind: "directory" },
      ];
    });
    fs.writeFileSync(path.join(f.root, "plugin.sqlite"), "fixture data; no native open", {
      mode: 0o600,
    });
    selection.entries = [
      { pluginId: "legacy-plugin", migration: legacy },
      { pluginId: "legacy-plugin", migration: migration("second") },
      { pluginId: "declared-plugin", migration: declared },
    ];
    await f.invoke();
    expect(f.launch).toHaveBeenCalledOnce();
    const fact = JSON.parse(f.runtime.log.mock.calls[0]![0]);
    expect(fact).toMatchObject({
      kind: "doctor-schema-rehearsal",
      stateDir: f.root,
      warnings: [{ kind: "undeclared-migration-resources", pluginId: "legacy-plugin" }],
    });
    expect(fact.warnings).toHaveLength(1);
    expect(f.runtime.error).toHaveBeenCalledExactlyOnceWith(`Warning: ${fact.warnings[0].message}`);
    expect(legacy.detectLegacyState).not.toHaveBeenCalled();
    expect(legacy.migrateLegacyState).not.toHaveBeenCalled();
    expect(declared.detectLegacyState).not.toHaveBeenCalled();
    expect(declared.migrateLegacyState).not.toHaveBeenCalled();
    expect(f.cleanup).toHaveBeenCalledOnce();
  });
});

it.each([
  "external-declaration",
  "malformed-declaration",
  "default-alias",
  "hardlink",
  "companion-alias",
] as const)("refuses %s before launching any writer", async (mode) => {
  await fixture(async (f) => {
    const declared = path.join(f.root, "declared.sqlite");
    if (mode === "default-alias") {
      fs.symlinkSync(f.external, path.join(f.root, "undeclared-data"));
    }
    if (mode === "hardlink") {
      fs.linkSync(path.join(f.external, "retained.txt"), path.join(f.root, "unowned"));
    }
    if (mode === "companion-alias") {
      fs.symlinkSync(path.join(f.external, "retained.txt"), `${declared}-wal`);
    }
    const entry = migration("declared", () =>
      mode === "malformed-declaration"
        ? ([{ path: declared, kind: "invalid" }] as unknown as { path: string; kind: "file" }[])
        : [
            {
              path:
                mode === "external-declaration" ? path.join(f.external, "retained.txt") : declared,
              kind: "sqlite",
            },
          ],
    );
    selection.entries = [{ pluginId: "test-plugin", migration: entry }];
    await expect(f.invoke()).rejects.toThrow(
      mode === "malformed-declaration" ? /Invalid migration/ : /escapes|unsafe ownership or links/,
    );
    expect(f.launch).not.toHaveBeenCalled();
    expect(entry.detectLegacyState).not.toHaveBeenCalled();
    expect(entry.migrateLegacyState).not.toHaveBeenCalled();
    expect(f.cleanup).toHaveBeenCalledOnce();
  });
});

it.each(["new-default-alias", "absent-destination-retarget", "config-replaced"] as const)(
  "rechecks %s at the actual launch boundary",
  async (mode) => {
    await fixture(async (f) => {
      selection.entries = [
        {
          pluginId: "test-plugin",
          migration: migration("declared", () => [
            { path: path.join(f.root, "future", "destination"), kind: "directory" },
          ]),
        },
      ];
      f.runtime.log.mockImplementationOnce(() => {
        if (mode === "config-replaced") {
          fs.renameSync(f.configPath, `${f.configPath}.old`);
          fs.writeFileSync(f.configPath, "{}", { mode: 0o600 });
        } else {
          fs.symlinkSync(
            f.external,
            path.join(f.root, mode === "absent-destination-retarget" ? "future" : "new-data"),
          );
        }
      });
      await expect(f.invoke()).rejects.toThrow(/unsafe ownership or links|identity changed/);
      expect(f.launch).not.toHaveBeenCalled();
      expect(f.cleanup).toHaveBeenCalledOnce();
    });
  },
);

it.each(["config", "state"] as const)(
  "requires the copied mandatory %s before any writer",
  async (missing) => {
    await fixture(async (f) => {
      fs.unlinkSync(missing === "config" ? f.configPath : f.statePath);
      await expect(f.invoke()).rejects.toThrow(/missing/);
      expect(f.launch).not.toHaveBeenCalled();
      expect(f.cleanup).toHaveBeenCalledOnce();
    });
  },
);

it("retains a copy when the admitted child cannot confirm settlement", async () => {
  await fixture(async (f) => {
    f.launch.mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
      signal: null,
      killed: false,
      termination: "exit",
      cleanup: "uncertain",
    });
    await expect(f.invoke()).rejects.toThrow(/did not settle/);
    expect(f.cleanup).not.toHaveBeenCalled();
    expect(fs.existsSync(f.statePath)).toBe(true);
  });
});

it("refuses a changed real parent identity after resource inventory", async () => {
  await fixture(async (f) => {
    const readDriver = drivers.readUpdateRunDriver;
    let held = true;
    vi.spyOn(drivers, "readUpdateRunDriver").mockImplementation((pid) =>
      held ? readDriver(pid) : undefined,
    );
    selection.entries = [
      {
        pluginId: "test-plugin",
        migration: migration("declared", () => {
          held = false;
          return [];
        }),
      },
    ];
    await expect(f.invoke()).rejects.toThrow(/parent identity changed/);
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.cleanup).toHaveBeenCalledOnce();
  });
});

it("refuses a legacy result output selector before any rehearsal writer", async () => {
  await fixture(async (f) => {
    f.env.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH = path.join(f.external, "result.json");
    await expect(f.invoke()).rejects.toThrow(/retained live selectors/);
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.cleanup).toHaveBeenCalledOnce();
  });
});

it("joins all inventory work before cleaning a rejected rehearsal", async () => {
  await fixture(async (f) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let settled = false;
    vi.spyOn(workshop, "collectDoctorSkillWorkshopBackupResources").mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      settled = true;
      return [];
    });
    selection.entries = [
      {
        pluginId: "invalid",
        migration: migration("invalid", () => [{ path: "relative", kind: "file" }]),
      },
    ];
    const pending = f.invoke();
    void pending.catch(() => {});
    try {
      await entered.promise;
      // One task boundary lets the rejected collector propagate; no elapsed-time wait.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(f.cleanup).not.toHaveBeenCalled();
      expect(fs.existsSync(f.statePath)).toBe(true);
    } finally {
      release.resolve();
      await expect(pending).rejects.toThrow(/Invalid migration/);
    }
    expect(settled).toBe(true);
    expect(f.cleanup).toHaveBeenCalledOnce();
    expect(f.launch).not.toHaveBeenCalled();
  });
});

it("retains a replacement root when final admission rejects its changed identity", async () => {
  await fixture(async (f) => {
    const displaced = path.join(f.external, "original-copy");
    const retained = path.join(f.root, "replacement-data");
    f.runtime.log.mockImplementationOnce(() => {
      fs.renameSync(f.root, displaced);
      fs.mkdirSync(f.root, { mode: 0o700 });
      fs.writeFileSync(retained, "replacement must survive", { mode: 0o600 });
    });
    await expect(f.invoke()).rejects.toThrow(/rehearsal root changed/);
    expect(fs.existsSync(retained)).toBe(true);
    expect(fs.readFileSync(retained, "utf8")).toBe("replacement must survive");
    expect(f.cleanup).not.toHaveBeenCalled();
    expect(f.launch).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(displaced, "state", "openclaw.sqlite"))).toBe(true);
  });
});

it("refuses parent replacement during initial asynchronous admission", async () => {
  await fixture(async (f) => {
    const readDriver = drivers.readUpdateRunDriver;
    let replaced = false;
    vi.spyOn(drivers, "readUpdateRunDriver").mockImplementation((pid) => {
      const current = readDriver(pid);
      return current && replaced ? { ...current, startIdentity: "replacement-parent" } : current;
    });
    vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockImplementation(async () => {
      replaced = true;
      return "package";
    });
    await expect(f.invoke()).rejects.toThrow(/parent identity changed/);
    expect(f.launch).not.toHaveBeenCalled();
    expect(snapshots.prepareUpdateCandidateRehearsal).not.toHaveBeenCalled();
    expect(f.cleanup).not.toHaveBeenCalled();
  });
});

it("retains the original parent across CLI schema selection", async () => {
  await fixture(async (f) => {
    const readDriver = drivers.readUpdateRunDriver;
    let replaced = false;
    vi.spyOn(drivers, "readUpdateRunDriver").mockImplementation((pid) => {
      const current = readDriver(pid);
      return current && replaced ? { ...current, startIdentity: "replacement-parent" } : current;
    });
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
    vi.spyOn(databasePreflight, "prepareDoctorDatabasePreflight").mockImplementation(async () => {
      replaced = true;
      return f.schemas;
    });
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
      throw new Error("Unexpected CLI exit after lost parent");
    });
    await expect(preflightUpdateDoctorCli({})).rejects.toThrow(/parent identity changed/);
    expect(f.launch).not.toHaveBeenCalled();
    expect(snapshots.prepareUpdateCandidateRehearsal).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
