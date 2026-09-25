import "./doctor-health.test-support.js";
import { execFile, fork, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import * as configFlow from "../commands/doctor-config-flow.js";
import { prepareDoctorDatabasePreflight } from "../commands/doctor-database-preflight.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { SQLITE_READONLY_CHILD_ARG } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import { createLegacyStateMigrationStepReceipt } from "../infra/state-migrations.messages.js";
import { listAgentDatabaseAdmissionRefusals } from "../state/agent-database-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import * as databasePreflight from "../state/openclaw-database-preflight.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveInitialDoctorHealthContributions } from "./doctor-health-contributions-initial.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFileSpy = vi.fn(actual.execFile);
  Object.defineProperty(
    execFileSpy,
    promisify.custom,
    Object.getOwnPropertyDescriptor(actual.execFile, promisify.custom)!,
  );
  return { ...actual, execFile: execFileSpy, fork: vi.fn(actual.fork), spawn: vi.fn(actual.spawn) };
});

const { mocks } = await import("./doctor-health.test-support.js");

beforeEach(() => {
  vi.mocked(execFile).mockReset();
  mocks.packageRoot.mockReturnValue(undefined);
  mocks.runContributions.mockReset();
});

it("shares one fleet preflight with Doctor admission and its health contribution", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { default: true }, second: {}, third: {}, fourth: {} } },
    };
    await state.writeConfig(cfg);
    mocks.config.mockReturnValue(cfg);
    for (const agentId of Object.keys(cfg.agents!.entries!)) {
      openOpenClawAgentDatabase({ agentId, env: state.env });
    }
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const noOp = async () => {};
    const admission = resolveInitialDoctorHealthContributions({
      runStructuredHealthRepairs: noOp,
      runGatewayConfigHealth: noOp,
      runAuthProfileMigration: noOp,
      runAuthProfileHealth: noOp,
      runGatewayAuthHealth: noOp,
      runLegacyStateHealth: noOp,
    }).find((contribution) => contribution.id === "doctor:agent-database-admission")!;
    mocks.runContributions.mockImplementation((ctx) => admission.run(ctx));
    const inspect = vi.spyOn(databasePreflight, "preflightOpenClawDatabaseSchemas");
    try {
      vi.mocked(execFile).mockClear();
      vi.mocked(fork).mockClear();
      vi.mocked(spawn).mockClear();
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      await runDoctorHealthFlow(runtime, { nonInteractive: true });

      expect(mocks.runContributions).toHaveBeenCalledOnce();
      expect(runtime.error).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(inspect.mock.calls.filter(([options]) => options.scope !== "state")).toHaveLength(1);
      const schemaEntry = String(resolveRuntimeProcessEntrypointUrl("agentSchemaInspection"));
      expect(
        vi.mocked(fork).mock.calls.filter(([entry]) => String(entry) === schemaEntry),
      ).toHaveLength(2);
      expect(
        vi
          .mocked(spawn)
          .mock.calls.filter(
            ([, args]) =>
              Array.isArray(args) &&
              args.includes(SQLITE_READONLY_CHILD_ARG) &&
              args.includes("session"),
          ),
      ).toHaveLength(2);
      expect(
        vi
          .mocked(execFile)
          .mock.calls.filter(([, args]) => Array.isArray(args) && args.includes("schema-header")),
      ).toHaveLength(0);
    } finally {
      inspect.mockRestore();
    }
  });
});

it.each(["copy", "hardlink", "relocated-copy"] as const)(
  "reconciles Doctor admission with physical quarantine across ancestor aliases: %s",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const originalRoot = state.stateDir;
      const relocatedRoot = state.path("relocated-state");
      const cleanerDirectory = state.statePath("agents", "cleaner");
      const configuredAlias = state.statePath("agent-alias");
      const sessionAlias = state.statePath("session-alias");
      const cfg: OpenClawConfig = {
        agents: {
          entries: {
            main: { default: true },
            cleaner: { agentDir: path.join(configuredAlias, "agent") },
          },
        },
        session: {
          store: path.join(sessionAlias, "agents", "{agentId}", "sessions", "sessions.json"),
        },
      };
      const ownerPath = openOpenClawAgentDatabase({ agentId: "main", env: state.env }).path;
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      const physicalCopyPath = path.join(cleanerDirectory, "agent", "openclaw-agent.sqlite");
      fs.mkdirSync(path.dirname(physicalCopyPath), { recursive: true });
      if (kind === "hardlink") {
        fs.linkSync(ownerPath, physicalCopyPath);
      } else {
        fs.copyFileSync(ownerPath, physicalCopyPath);
      }
      const originalBytes = fs.readFileSync(physicalCopyPath);
      fs.symlinkSync(cleanerDirectory, configuredAlias, "dir");
      fs.symlinkSync(originalRoot, sessionAlias, "dir");
      await state.writeConfig(cfg);
      mocks.config.mockReturnValue(cfg);
      const noOp = async () => {};
      const admission = resolveInitialDoctorHealthContributions({
        runStructuredHealthRepairs: noOp,
        runGatewayConfigHealth: noOp,
        runAuthProfileMigration: noOp,
        runAuthProfileHealth: noOp,
        runGatewayAuthHealth: noOp,
        runLegacyStateHealth: noOp,
      }).find((contribution) => contribution.id === "doctor:agent-database-admission")!;
      mocks.runContributions.mockImplementation((ctx) => admission.run(ctx));
      const inspect = vi.spyOn(databasePreflight, "preflightOpenClawDatabaseSchemas");
      const loadConfig = configFlow.loadAndMaybeMigrateDoctorConfig;
      const migration = vi
        .spyOn(configFlow, "loadAndMaybeMigrateDoctorConfig")
        .mockImplementation(async (params) => {
          const result = await loadConfig(params);
          if (kind === "relocated-copy") {
            closeOpenClawAgentDatabasesForTest();
            closeOpenClawStateDatabaseForTest();
            // The state-dir owner preserves the old locator after moving the whole root.
            fs.renameSync(originalRoot, relocatedRoot);
            fs.symlinkSync(relocatedRoot, originalRoot, "dir");
            process.env.OPENCLAW_STATE_DIR = relocatedRoot;
          }
          const repaired = await migrateLegacyMediaPersistence({
            env: process.env,
            configuredAgentDatabaseTargets: resolveConfiguredAgentDatabaseTargets(result.cfg, {
              env: process.env,
            }),
            preparedDiscovery: params.agentDatabaseMigrationDiscovery,
          });
          return {
            ...result,
            stateMigrationStepReceipts: [
              createLegacyStateMigrationStepReceipt(
                {
                  id: "media-persistence",
                  phase: "shared",
                  source: [],
                  target: [],
                  requiredness: "conditional",
                  reversibility: "checkpoint-required",
                },
                repaired,
              ),
            ],
          };
        });
      try {
        const prepared = await prepareDoctorDatabasePreflight();
        const refusedPath = path.join(configuredAlias, "agent", "openclaw-agent.sqlite");
        expect(prepared.agentRefusals).toEqual([
          expect.objectContaining({
            agentId: "cleaner",
            paths: [refusedPath],
            code: "agent-database-ownership-mismatch",
          }),
        ]);
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        await runDoctorHealthFlow(runtime, { nonInteractive: true }, undefined, prepared);
        expect(runtime.error).not.toHaveBeenCalled();
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(mocks.runContributions).toHaveBeenCalledOnce();
        const refusals = listAgentDatabaseAdmissionRefusals({ env: process.env });
        expect(refusals).toEqual(kind === "hardlink" ? prepared.agentRefusals : []);
        expect(mocks.runContributions.mock.calls[0]?.[0].agentDatabaseRefusals).toEqual(refusals);
        expect(inspect.mock.calls.filter(([options]) => options.scope !== "state")).toHaveLength(
          kind === "relocated-copy" ? 2 : 1,
        );
        const currentCopyPath =
          kind === "relocated-copy"
            ? path.join(relocatedRoot, "agents", "cleaner", "agent", "openclaw-agent.sqlite")
            : physicalCopyPath;
        const backups = fs
          .readdirSync(path.dirname(currentCopyPath))
          .filter((name) => name.startsWith("openclaw-agent.sqlite.corrupt-"));
        if (kind === "hardlink") {
          expect(backups).toEqual([]);
          expect(fs.statSync(currentCopyPath).ino).toBe(fs.statSync(ownerPath).ino);
        } else {
          expect(fs.existsSync(currentCopyPath)).toBe(false);
          expect(backups).toHaveLength(1);
          expect(fs.readFileSync(path.join(path.dirname(currentCopyPath), backups[0]!))).toEqual(
            originalBytes,
          );
        }
      } finally {
        migration.mockRestore();
        inspect.mockRestore();
      }
    });
  },
);
