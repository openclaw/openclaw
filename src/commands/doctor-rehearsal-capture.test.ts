import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { sha256Hex } from "../infra/crypto-digest.js";
import { resolveUpdateCaptureRoot } from "../infra/update-capture-paths.js";
import { captureUpdateRecoveryBaseline } from "../infra/update-recovery-baseline-capture.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import type { PluginDoctorStateMigration } from "../plugins/doctor-contract-module.js";
import * as pluginResources from "../plugins/doctor-contract-registry.js";
import { preparePluginDoctorMigrationResources } from "../plugins/doctor-migration-resources.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { parseUpdateRecoveryBackupManifest } from "./backup-verify-manifest.js";
import * as doctorAdmission from "./doctor-maintenance-admission.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";
import { backupDoctorMigrationDatabases } from "./doctor-migration-backup.js";
import { preserveDoctorOriginalState } from "./doctor-original-capture.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps config and declared plugin resources while excluding disposable core images and aliases", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const stateDir = await fs.realpath(state.stateDir);
    await withEnvAsync(
      {
        ...buildUpdateRehearsalPathEnv(stateDir),
        OPENCLAW_UPDATE_IN_PROGRESS: "0",
        OPENCLAW_SERVICE_REPAIR_POLICY: "external",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
        OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
        OPENCLAW_UPDATE_RUN_ID: undefined,
      },
      async () => {
        const shared = resolveOpenClawStateSqlitePath();
        const serviceIntent = path.join(stateDir, "control", "services.sqlite");
        const agent = resolveOpenClawAgentSqlitePath({ agentId: "main" });
        openOpenClawStateDatabase();
        openOpenClawAgentDatabase({ agentId: "main" });
        await closeOpenClawAgentDatabasesAsync();
        await closeOpenClawStateDatabaseAsync();
        const plugin = state.path("external-plugin-data");
        const declared = path.join(stateDir, "synthetic-declared");
        await fs.mkdir(plugin);
        await fs.mkdir(declared);
        const pluginDatabase = path.join(plugin, "plugin.sqlite");
        {
          using db = new DatabaseSync(pluginDatabase);
          db.exec(
            "CREATE TABLE payload(value TEXT); INSERT INTO payload VALUES('plugin recovery');",
          );
        }
        const skill = path.join(declared, "SKILL.md");
        await fs.writeFile(skill, "retain declared repair input");
        const alias = path.join(declared, "agent.sqlite");
        await fs.symlink(agent, alias);
        await fs.writeFile(`${agent}-journal`, "");
        const companionAlias = path.join(declared, "agent.sqlite-journal");
        await fs.symlink(`${agent}-journal`, companionAlias);
        const legacyCanvasRoot = path.join(stateDir, "legacy-canvas-host");
        const canvasDocument = path.join(legacyCanvasRoot, "documents", "retained", "index.html");
        const canvasDestination = path.join(stateDir, "canvas", "documents");
        await fs.mkdir(path.dirname(canvasDocument), { recursive: true });
        await fs.writeFile(canvasDocument, "original Canvas document");
        const { stateMigrations } = await loadBundledPluginFacade<{
          stateMigrations: PluginDoctorStateMigration[];
        }>({ pluginId: "canvas", artifactBasename: "doctor-contract-api.ts" });
        const rawConfig = await fs.readFile(state.configPath);
        const sourceBytes = await Promise.all(
          [shared, agent, pluginDatabase, skill].map((file) => fs.readFile(file)),
        );
        // Synthetic declarations isolate plugin execution; discovery, native custody,
        // snapshots, file traversal, manifests and publication use production code.
        const warning = {
          kind: "undeclared-migration-resources" as const,
          pluginId: "synthetic-legacy",
          message: "Synthetic legacy resources are undeclared",
        };
        vi.spyOn(pluginResources, "preparePluginDoctorMigrationBackupResources").mockImplementation(
          async (params) => {
            params.warnings.push(warning);
            const canvas = await preparePluginDoctorMigrationResources(
              stateMigrations.map((migration) => ({ pluginId: "canvas", migration })),
              {
                ...params,
                config: {
                  plugins: {
                    entries: { canvas: { config: { host: { root: legacyCanvasRoot } } } },
                  },
                },
              },
            );
            return {
              resources: [
                ...canvas.resources,
                { path: plugin, kind: "directory" },
                { path: declared, kind: "directory" },
                { path: shared, kind: "sqlite" },
              ],
              deferredPluginIds: new Set(),
              notices: [],
              assertCurrent() {},
            };
          },
        );
        const messages: string[] = [];
        const log = (...args: unknown[]) => {
          messages.push(args.map(String).join(" "));
        };
        const runtime: RuntimeEnv = {
          log,
          error: log,
          exit: () => {
            throw new Error("Doctor exited unexpectedly");
          },
        };
        const captures = resolveUpdateCaptureRoot(stateDir);
        const maintenance = await beginDoctorMaintenance({
          root: process.cwd(),
          options: { repair: true, nonInteractive: true },
          runtime,
        });
        expect(maintenance).toBeDefined();
        try {
          const captureResult = await maintenance!.run(async () => {
            const scope = getOpenClawDatabaseMaintenanceScope()!;
            const result = await preserveDoctorOriginalState({
              root: process.cwd(),
              env: process.env,
              runtime,
              signal: maintenance!.signal,
              assertCurrent: scope.assertAdmission,
            });
            await backupDoctorMigrationDatabases({
              env: process.env,
              pendingDatabasePaths: [agent],
              databasePaths: [agent],
            });
            return result;
          });
          const names = (await fs.readdir(captures)).filter((name) => name.startsWith("doctor-"));
          expect(names, messages.join("\n")).toHaveLength(1);
          const directory = path.join(captures, names[0]!);
          const manifestPath = path.join(directory, "manifest.json");
          const manifestBytes = await fs.readFile(manifestPath);
          const manifest = parseUpdateRecoveryBackupManifest(manifestBytes.toString());
          expect(manifest.databases).toEqual([]);
          expect(manifest.entries).toContainEqual({
            kind: "missing",
            sourcePath: serviceIntent,
            sqlite: true,
            directory: false,
          });
          for (const file of [shared, agent, `${agent}-journal`, alias, companionAlias]) {
            expect(manifest.excludedRoots).toContain(file);
            expect(manifest.entries.some((entry) => entry.sourcePath === file)).toBe(false);
          }
          const payload = (file: string) => {
            const entry = manifest.entries.find((candidate) => candidate.sourcePath === file);
            if (entry?.kind !== "file") {
              throw new Error(`Capture is missing ${file}: ${messages.join("\n")}`);
            }
            return path.join(directory, entry.archivePath);
          };
          expect(await fs.readFile(payload(state.configPath))).toEqual(rawConfig);
          expect(await fs.readFile(payload(skill))).toEqual(sourceBytes[3]);
          expect(await fs.readFile(payload(canvasDocument), "utf8")).toBe(
            "original Canvas document",
          );
          expect(manifest.entries).toContainEqual({
            kind: "missing",
            sourcePath: canvasDestination,
            sqlite: false,
            directory: true,
          });
          expect((manifest.warnings ?? []).some((entry) => entry.pluginId === "canvas")).toBe(
            false,
          );
          {
            using captured = new DatabaseSync(payload(pluginDatabase), { readOnly: true });
            expect(captured.prepare("SELECT value FROM payload").all()).toEqual([
              { value: "plugin recovery" },
            ]);
          }
          expect(manifest.warnings).toContainEqual(warning);
          expect(captureResult.findings).toContainEqual(
            expect.objectContaining({
              category: "recommended",
              errorCode: "undeclared-migration-resources",
              message:
                "synthetic-legacy migration recovery coverage is unknown because no backup inventory was declared.",
              fixHint: expect.any(String),
              docsUrl: expect.any(String),
            }),
          );
          expect(captureResult.warnings).toContain("Synthetic legacy resources are undeclared");
          expect(messages).not.toContain("Synthetic legacy resources are undeclared");
          for (const file of [shared, agent]) {
            expect(
              (await fs.readdir(path.dirname(file))).some(
                (name) => name.includes(".pre-startup-migration-") && name.endsWith(".bak"),
              ),
            ).toBe(false);
          }
          const laterWorkspace = state.path("later-declared-workspace");
          const workspaceFile = path.join(laterWorkspace, "document.txt");
          await fs.mkdir(laterWorkspace);
          await fs.writeFile(workspaceFile, "workspace omitted from the original inventory");
          expect(manifest.entries.some((entry) => entry.sourcePath === laterWorkspace)).toBe(false);
          vi.mocked(pluginResources.preparePluginDoctorMigrationBackupResources).mockResolvedValue({
            resources: [{ path: laterWorkspace, kind: "directory" }],
            deferredPluginIds: new Set(),
            notices: [],
            assertCurrent() {},
          });
          vi.stubGlobal("SEALED_RUNTIME_BUILD", true);
          await maintenance!.run(async () => {
            const scope = getOpenClawDatabaseMaintenanceScope()!;
            vi.spyOn(doctorAdmission, "resolveDoctorUpdateAdmission").mockReturnValue({
              assertCurrent: scope.assertAdmission,
              readContinuation: () => undefined,
              recordContinuation() {},
            });
            await preserveDoctorOriginalState({
              root: process.cwd(),
              env: process.env,
              runtime,
              signal: maintenance!.signal,
              assertCurrent: scope.assertAdmission,
              writeAuthority: {
                inputHash: "synthetic-config-hash",
                assertCurrent: scope.assertAdmission,
                originalRecoveryCapture: {
                  runId: manifest.runId,
                  installRoot: process.cwd(),
                  ref: { directory, manifestPath, manifestSha256: sha256Hex(manifestBytes) },
                },
              },
            });
          });
          expect((await fs.readdir(captures)).filter((name) => name.startsWith("doctor-"))).toEqual(
            names,
          );
          expect(await fs.readFile(manifestPath)).toEqual(manifestBytes);
          expect(await fs.readFile(workspaceFile, "utf8")).toBe(
            "workspace omitted from the original inventory",
          );
        } finally {
          await maintenance?.release();
          await fs.rm(captures, { recursive: true, force: true });
        }
        expect(
          await Promise.all(
            [shared, agent, pluginDatabase, skill].map((file) => fs.readFile(file)),
          ),
        ).toEqual(sourceBytes);
      },
    );
  });
});

it("refuses to seal exclusions when the rehearsal environment changes during capture", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const stateDir = await fs.realpath(state.stateDir);
    const env: NodeJS.ProcessEnv = {
      ...buildUpdateRehearsalPathEnv(stateDir),
      OPENCLAW_UPDATE_IN_PROGRESS: "0",
      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
    };
    await withEnvAsync(env, async () => {
      openOpenClawStateDatabase();
      await closeOpenClawStateDatabaseAsync();
      const runtime = {
        log() {},
        error() {},
        exit() {
          throw new Error("Doctor exited unexpectedly");
        },
      };
      const maintenance = await beginDoctorMaintenance({
        root: process.cwd(),
        options: { repair: true, nonInteractive: true },
        runtime,
      });
      expect(maintenance).toBeDefined();
      const captures = resolveUpdateCaptureRoot(stateDir);
      vi.spyOn(pluginResources, "preparePluginDoctorMigrationBackupResources").mockImplementation(
        async () => {
          env.TMPDIR = path.dirname(stateDir);
          return {
            resources: [],
            deferredPluginIds: new Set(),
            notices: [],
            assertCurrent() {},
          };
        },
      );
      try {
        await maintenance!.run(async () => {
          const scope = getOpenClawDatabaseMaintenanceScope()!;
          await expect(
            captureUpdateRecoveryBaseline({
              runId: "changed-rehearsal",
              installRoot: process.cwd(),
              env,
              drivers: [],
              assertCurrent: scope.assertAdmission,
              signal: maintenance!.signal,
            }),
          ).rejects.toThrow(/namespace changed/);
        });
        await expect(fs.lstat(captures)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await maintenance?.release();
        await fs.rm(captures, { recursive: true, force: true });
      }
    });
  });
});
