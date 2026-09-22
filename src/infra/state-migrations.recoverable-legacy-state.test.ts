import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "../agents/config.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import {
  coercePluginDoctorContractModule,
  type PluginDoctorContractModule,
} from "../plugins/doctor-contract-module.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveSqliteDatabaseFilePaths } from "./sqlite-files.js";
import {
  detectLegacyStateMigrations,
  planLegacyStateMigrationsReadOnly,
} from "./state-migrations.doctor.js";
import { migrateLegacyAgentDir } from "./state-migrations.legacy-sessions.js";
import {
  createLegacyStateMigrationStepReceipt,
  throwIfDoctorStateMigrationRefused,
} from "./state-migrations.messages.js";
import { createPluginDoctorStateMigrationContext } from "./state-migrations.plugin-doctor-context.js";
import { runLegacyMigrationPlans } from "./state-migrations.plugin-state.js";
import type { MigrationMessages } from "./state-migrations.types.js";
import { migrateLegacyUpdateCheckState } from "./state-migrations.update-check.js";

function migrationReceipt(id: string, result: MigrationMessages) {
  return createLegacyStateMigrationStepReceipt(
    {
      id,
      phase: "shared",
      source: [],
      target: [],
      requiredness: "required",
      reversibility: "checkpoint-required",
    },
    result,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginStateStoreForTests();
});

describe("recoverable legacy state", () => {
  it.each([
    { failure: "malformed", canonical: true },
    { failure: "unreadable", canonical: true },
    { failure: "malformed", canonical: false },
    { failure: "unreadable", canonical: false },
  ])(
    "keeps $failure update metadata advisory only with canonical state=$canonical",
    async ({ failure, canonical }) => {
      await withOpenClawTestState({ label: "update-check-recovery" }, async ({ stateDir, env }) => {
        const sourcePath = path.join(stateDir, "update-check.json");
        const sourceBytes = failure === "malformed" ? "{invalid legacy JSON" : "{}";
        await fs.writeFile(sourcePath, sourceBytes);
        const canonicalState = {
          autoInstallId: "canonical-install",
          autoFirstSeenVersion: "2026.9.3",
          autoFirstSeenAt: "2026-09-08T00:00:00.000Z",
          autoLastAttemptVersion: "2026.9.3",
          autoLastAttemptAt: "2026-09-08T01:00:00.000Z",
        };
        if (canonical) {
          writeConfigMachineState("update.checkState", canonicalState, { env });
        }
        if (failure === "unreadable") {
          const readFile = fsSync.readFileSync;
          vi.spyOn(fsSync, "readFileSync").mockImplementation((target, options) => {
            if (target === sourcePath) {
              throw new Error("synthetic legacy cache permission denied");
            }
            return readFile(target, options);
          });
        }

        const result = migrateLegacyUpdateCheckState({
          stateDir,
          detected: { sourcePath, hasLegacy: true },
        });
        const receipt = migrationReceipt("update-check", result);

        await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe(sourceBytes);
        expect(readConfigMachineState("update.checkState", { env })).toEqual(
          canonical ? canonicalState : undefined,
        );
        expect(receipt.warnings.join("\n")).toContain("update-check");
        if (canonical) {
          expect(() => throwIfDoctorStateMigrationRefused([receipt])).not.toThrow();
          expect(receipt.outcome).toBe("warning");
          expect(receipt.warnings.join("\n")).toContain("openclaw doctor --fix");
        } else {
          expect(() => throwIfDoctorStateMigrationRefused([receipt])).toThrow(
            "Doctor stopped because a state migration refused",
          );
          expect(receipt.outcome).toBe("refused");
        }
        vi.restoreAllMocks();
      });
    },
  );

  it.each([false, true])(
    "keeps Discord cache cleanup advisory unless another import fails (%s)",
    async (failedImport) => {
      await withOpenClawTestState({ label: "discord-cache-cleanup" }, async ({ stateDir, env }) => {
        const discordDir = path.join(stateDir, "discord");
        const sourcePath = path.join(discordDir, "command-deploy-cache.json");
        await fs.mkdir(discordDir, { recursive: true });
        await fs.writeFile(sourcePath, "retired deploy hashes");
        if (failedImport) {
          await fs.writeFile(path.join(discordDir, "thread-bindings.json"), "{}");
        }
        const unlink = fsSync.unlinkSync;
        vi.spyOn(fsSync, "unlinkSync").mockImplementation((target) => {
          if (target === sourcePath) {
            throw new Error("synthetic cache cleanup permission denied");
          }
          unlink(target);
        });
        const { stateMigrations } = coercePluginDoctorContractModule(
          await vi.importActual<PluginDoctorContractModule>(
            path.resolve("extensions/discord/doctor-contract-api.ts"),
          ),
        );
        const migration = expectDefined(stateMigrations?.[0], "Discord Doctor migration");
        const params = {
          config: {},
          env,
          stateDir,
          oauthDir: path.join(stateDir, "credentials"),
          context: createPluginDoctorStateMigrationContext({
            pluginId: "discord",
            env,
            config: {},
          }),
        };

        const result = await migration.migrateLegacyState(params);
        const receipt = migrationReceipt(migration.id, result);

        await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("retired deploy hashes");
        expect(receipt.warnings.join("\n")).toContain("Discord command deployment cache");
        expect(receipt.warnings.join("\n")).toContain("synthetic cache cleanup permission denied");
        if (failedImport) {
          expect(() => throwIfDoctorStateMigrationRefused([receipt])).toThrow(
            "Doctor stopped because a state migration refused",
          );
          expect(receipt.warnings.join("\n")).toContain("legacy Discord thread bindings store");
        } else {
          expect(() => throwIfDoctorStateMigrationRefused([receipt])).not.toThrow();
          expect(receipt.outcome).toBe("warning");
          expect(receipt.warnings.join("\n")).toContain("openclaw doctor --fix");
        }
        vi.restoreAllMocks();
        if (!failedImport) {
          expect((await migration.migrateLegacyState(params)).warnings).toEqual([]);
          await expect(fs.stat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
        }
      });
    },
  );

  it("keeps a shared source blocked when another cleanup owner does not opt in", async () => {
    await withOpenClawTestState({ label: "shared-cleanup-policy" }, async ({ stateDir }) => {
      const sourcePath = path.join(stateDir, "shared-cache.json");
      await fs.writeFile(sourcePath, "retained source");
      const unlink = fsSync.unlinkSync;
      vi.spyOn(fsSync, "unlinkSync").mockImplementation((target) => {
        if (target === sourcePath) {
          throw new Error("synthetic shared cleanup failure");
        }
        unlink(target);
      });

      const result = await runLegacyMigrationPlans(
        ["optional", "required"].map((namespace) => ({
          kind: "plugin-state-import",
          label: `${namespace} state`,
          sourcePath,
          targetPath: `plugin state:${namespace}`,
          pluginId: "cleanup-fixture",
          namespace,
          stateDir,
          maxEntries: 10,
          scopeKey: "",
          cleanupSource: "remove",
          cleanupWhenEmpty: true,
          cleanupWarningDisposition: namespace === "optional" ? "recoverable" : undefined,
          readEntries: () => [],
        })),
      );

      const receipt = migrationReceipt("shared-cleanup", result);
      expect(() => throwIfDoctorStateMigrationRefused([receipt])).toThrow(
        "Doctor stopped because a state migration refused",
      );
      await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("retained source");
      vi.restoreAllMocks();
    });
  });
});

describe("legacy agent directory migration", () => {
  it.each<{
    relativeDatabase: string;
    destination: "database" | "wal" | "journal" | "empty";
    orphanSource?: boolean;
    blockedRestore?: "database" | "wal" | "shm";
  }>([
    { relativeDatabase: "openclaw-agent.sqlite", destination: "database" },
    { relativeDatabase: "state/openclaw.sqlite", destination: "database" },
    { relativeDatabase: "sessions/transcripts.sqlite", destination: "database" },
    { relativeDatabase: "cache.db", destination: "empty" },
    { relativeDatabase: "custom-store", destination: "wal" },
    { relativeDatabase: "sessions/transcripts.sqlite", destination: "journal" },
    { relativeDatabase: "state/openclaw.sqlite", destination: "empty" },
    { relativeDatabase: "sessions/transcripts.sqlite", destination: "empty", orphanSource: true },
    ...(["database", "wal", "shm"] as const).map((blockedRestore) => ({
      relativeDatabase: "openclaw-agent.sqlite",
      destination: "empty" as const,
      blockedRestore,
    })),
  ])(
    "leaves SQLite families in place while merging files ($relativeDatabase, destination: $destination, blocked restore: $blockedRestore)",
    async ({ relativeDatabase, destination, orphanSource, blockedRestore }) => {
      await withOpenClawTestState(
        { label: "legacy-agent-family-deferred", layout: "split", agentEnv: "clear" },
        async (state) => {
          const legacyDir = path.join(state.home, ".openclaw", "agent");
          const targetDir = state.agentDir("main");
          const sourceDatabase = path.join(legacyDir, relativeDatabase);
          const otherDatabase = path.join(legacyDir, "a-other.sqlite");
          const targetDatabase = path.join(targetDir, relativeDatabase);
          for (const directory of [
            path.dirname(sourceDatabase),
            path.dirname(targetDatabase),
            path.join(legacyDir, "bin"),
            path.join(targetDir, "bin"),
          ]) {
            await fs.mkdir(directory, { recursive: true });
          }
          await fs.writeFile(path.join(legacyDir, "bin/fd"), "installed legacy tool");
          await fs.writeFile(path.join(legacyDir, "bin/collision"), "legacy binary");
          await fs.writeFile(path.join(targetDir, "bin/collision"), "current binary");
          const failedBinary = path.join(legacyDir, "bin/zz-fail");
          if (blockedRestore) {
            await fs.writeFile(failedBinary, "retained binary");
          }
          const seed = openOpenClawAgentDatabase({
            agentId: "main",
            env: state.env,
            path: state.statePath("seed.sqlite"),
          });
          try {
            seed.db.exec(
              "PRAGMA wal_autocheckpoint=0; CREATE TABLE wal_proof(value TEXT); PRAGMA wal_checkpoint(TRUNCATE);",
            );
            if (destination === "database") {
              fsSync.copyFileSync(seed.path, targetDatabase);
            } else if (destination !== "empty") {
              fsSync.writeFileSync(`${targetDatabase}-${destination}`, "unrelated recovery bytes");
            }
            seed.db.exec("INSERT INTO wal_proof VALUES ('legacy WAL row');");
            for (const file of resolveSqliteDatabaseFilePaths(seed.path).filter((candidate) =>
              fsSync.existsSync(candidate),
            )) {
              for (const database of [sourceDatabase, otherDatabase]) {
                fsSync.copyFileSync(file, `${database}${file.slice(seed.path.length)}`);
              }
            }
          } finally {
            closeOpenClawAgentDatabasesForTest();
          }
          const destinationFiles = () =>
            resolveSqliteDatabaseFilePaths(targetDatabase).map((file) =>
              fsSync.existsSync(file)
                ? createHash("sha256").update(fsSync.readFileSync(file)).digest("hex")
                : null,
            );
          const originalDestination = destinationFiles();
          const walBytes = await fs.readFile(`${sourceDatabase}-wal`);
          expect(walBytes.length).toBeGreaterThan(32);
          const mainOnly = state.statePath("main-only.sqlite");
          await fs.copyFile(sourceDatabase, mainOnly);
          const withoutWal = new DatabaseSync(mainOnly, { readOnly: true });
          try {
            expect(withoutWal.prepare("SELECT value FROM wal_proof").all()).toEqual([]);
          } finally {
            withoutWal.close();
          }
          if (orphanSource) {
            await fs.unlink(sourceDatabase);
          }
          const detect = () =>
            detectLegacyStateMigrations({
              cfg: { agents: { entries: { main: {} } }, plugins: { enabled: false } },
              env: state.env,
              homedir: () => state.home,
              legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
            });
          const detected = await detect();
          const families = [otherDatabase, sourceDatabase].map((database) => ({
            database,
            files: resolveSqliteDatabaseFilePaths(database).filter((file) =>
              fsSync.existsSync(file),
            ),
            destination: path.join(targetDir, path.relative(legacyDir, database)),
            outcome: "deferred",
            reason: "sqlite-family",
          }));
          const rename = fsSync.renameSync;
          const renameSpy = vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
            if (
              blockedRestore &&
              (String(from) === failedBinary ||
                (String(from) ===
                  `${targetDatabase}${blockedRestore === "database" ? "" : `-${blockedRestore}`}` &&
                  String(to) ===
                    `${sourceDatabase}${blockedRestore === "database" ? "" : `-${blockedRestore}`}`))
            ) {
              throw new Error("injected binary or family restore failure");
            }
            rename(from, to);
          });
          const copy = fsSync.copyFileSync;
          const copySpy = vi.spyOn(fsSync, "copyFileSync").mockImplementation((from, to, mode) => {
            if (blockedRestore && String(from) === failedBinary) {
              throw new Error("injected binary move failure");
            }
            copy(from, to, mode);
          });
          const result = await migrateLegacyAgentDir(detected, () => 1234);
          const receipt = migrationReceipt("agent-dir", result);
          expect(destinationFiles()).toEqual(originalDestination);
          for (const family of families) {
            for (const file of family.files) {
              expect(fsSync.existsSync(file), `Retained family member: ${file}`).toBe(true);
            }
            expect(receipt.sqliteFamilies).toContainEqual(family);
          }
          expect(receipt.sqliteFamilies).toHaveLength(2);
          expect(receipt.outcome).toBe("deferred");
          expect(() => throwIfDoctorStateMigrationRefused([receipt])).not.toThrow();
          expect(receipt.warnings.join("\n")).toContain("a later release moves it");
          expect(fsSync.existsSync(path.join(targetDir, ".legacy-agent-dir-migration.json"))).toBe(
            false,
          );
          expect(getAgentDir()).toBe(legacyDir);
          await expect(fs.readFile(path.join(targetDir, "bin/fd"), "utf8")).resolves.toBe(
            "installed legacy tool",
          );
          await expect(fs.readFile(path.join(legacyDir, "bin/fd"), "utf8")).resolves.toBe(
            "installed legacy tool",
          );
          await expect(fs.readFile(path.join(legacyDir, "bin/collision"), "utf8")).resolves.toBe(
            "legacy binary",
          );
          await expect(fs.readFile(path.join(targetDir, "bin/collision"), "utf8")).resolves.toBe(
            "current binary",
          );
          expect(
            (await fs.readdir(state.stateDir)).filter((name) => name.startsWith("agent.legacy-")),
          ).toEqual([]);
          const touchesFamily = (from: fsSync.PathLike) =>
            families.some((family) =>
              family.files.some(
                (file) => file === String(from) || file.startsWith(`${String(from)}${path.sep}`),
              ),
            );
          expect(renameSpy.mock.calls.some(([from]) => touchesFamily(from))).toBe(false);
          expect(copySpy.mock.calls.some(([from]) => touchesFamily(from))).toBe(false);
          if (blockedRestore) {
            expect(receipt.warnings.join("\n")).toContain("injected binary move failure");
            await expect(fs.readFile(failedBinary, "utf8")).resolves.toBe("retained binary");
          }
          const repeated = migrationReceipt(
            "agent-dir",
            await migrateLegacyAgentDir(await detect(), () => 5678),
          );
          expect(repeated.sqliteFamilies).toEqual(receipt.sqliteFamilies);
          expect(
            (await fs.readdir(state.stateDir)).filter((name) => name.startsWith("agent.legacy-")),
          ).toEqual([]);
          if (orphanSource) {
            await fs.copyFile(mainOnly, sourceDatabase);
          }
          for (const database of [sourceDatabase, otherDatabase]) {
            expect(await fs.readFile(`${database}-wal`)).toEqual(walBytes);
            const recovered = new DatabaseSync(database, { readOnly: true });
            try {
              expect(recovered.prepare("SELECT value FROM wal_proof").all()).toEqual([
                { value: "legacy WAL row" },
              ]);
            } finally {
              recovered.close();
            }
          }
        },
      );
    },
  );

  it("defers SDK home payload outside a copied state snapshot without opening it", async () => {
    await withOpenClawTestState(
      { label: "standalone-agent-snapshot", layout: "split", agentEnv: "clear" },
      async (state) => {
        const legacyDir = path.join(state.home, ".openclaw", "agent");
        await fs.mkdir(path.join(legacyDir, "bin"), { recursive: true });
        await fs.writeFile(path.join(legacyDir, "bin/fd"), "uncopied SDK binary");
        await state.writeConfig({ agents: { entries: { main: {} } }, plugins: { enabled: false } });
        const readDirectory = vi.spyOn(fsSync, "readdirSync");

        const plan = await planLegacyStateMigrationsReadOnly({
          mode: "doctor",
          candidate: { root: process.cwd(), version: "test" },
          snapshot: { homeDir: state.home, stateDir: state.stateDir, configPath: state.configPath },
          env: state.env,
          legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        });

        expect(plan.warnings).toContainEqual(
          expect.stringContaining(`outside the copied state snapshot: ${legacyDir}`),
        );
        expect(readDirectory.mock.calls.some(([directory]) => directory === legacyDir)).toBe(false);
        expect(plan.steps.flatMap((step) => step.source)).not.toContainEqual({
          kind: "path",
          path: legacyDir,
        });
        await expect(fs.readFile(path.join(legacyDir, "bin/fd"), "utf8")).resolves.toBe(
          "uncopied SDK binary",
        );
      },
    );
  });

  it.each(["OPENCLAW_STATE_DIR", "OPENCLAW_HOME"])(
    "migrates the shipped SDK directory with %s and preserves state-root migration",
    async (override) => {
      await withOpenClawTestState(
        { label: "standalone-agent-override", layout: "split", agentEnv: "clear" },
        async (state) => {
          const overrideHome = path.join(state.root, "override-home");
          const stateDir =
            override === "OPENCLAW_HOME" ? path.join(overrideHome, ".openclaw") : state.stateDir;
          const env = {
            ...state.env,
            OPENCLAW_STATE_DIR: override === "OPENCLAW_STATE_DIR" ? stateDir : "",
            OPENCLAW_HOME: override === "OPENCLAW_HOME" ? overrideHome : "",
          };
          vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
          vi.stubEnv("OPENCLAW_HOME", env.OPENCLAW_HOME);
          try {
            const legacyDir = path.join(state.home, ".openclaw", "agent");
            const stateLegacyDir = path.join(stateDir, "agent");
            const canonicalDir = path.join(stateDir, "agents", "main", "agent");
            for (const { directory, binary, contents } of [
              { directory: legacyDir, binary: "fd", contents: "SDK binary" },
              { directory: stateLegacyDir, binary: "rg", contents: "state legacy binary" },
              { directory: canonicalDir, binary: "rg", contents: "current binary" },
            ]) {
              await fs.mkdir(path.join(directory, "bin"), { recursive: true });
              await fs.writeFile(path.join(directory, "bin", binary), contents);
            }
            const sourceRoot = await fs.realpath(legacyDir);
            const detect = () =>
              detectLegacyStateMigrations({
                cfg: { agents: { entries: { main: {} } } },
                env,
                legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
              });
            const detected = await detect();
            expect(detected.preview).toContainEqual(expect.stringContaining(legacyDir));
            expect(detected.preview).toContainEqual(expect.stringContaining(stateLegacyDir));
            expect(getAgentDir()).toBe(legacyDir);
            const result = await migrateLegacyAgentDir(detected, () => 1234);

            expect(getAgentDir()).toBe(canonicalDir);
            await expect(fs.readFile(path.join(canonicalDir, "bin/fd"), "utf8")).resolves.toBe(
              "SDK binary",
            );
            await expect(fs.readFile(path.join(canonicalDir, "bin/rg"), "utf8")).resolves.toBe(
              "current binary",
            );
            const receipt = await fs.readFile(
              path.join(canonicalDir, ".legacy-agent-dir-migration.json"),
              "utf8",
            );
            expect(JSON.parse(receipt)).toEqual({
              version: 1,
              source: sourceRoot,
              target: await fs.realpath(canonicalDir),
            });
            await expect(fs.stat(legacyDir)).rejects.toMatchObject({ code: "ENOENT" });
            await expect(fs.stat(stateLegacyDir)).rejects.toMatchObject({ code: "ENOENT" });
            const quarantines = (await fs.readdir(stateDir)).filter((name) =>
              name.startsWith("agent.legacy-"),
            );
            expect(quarantines).toHaveLength(1);
            const quarantine = path.join(
              stateDir,
              expectDefined(quarantines[0], "state-root quarantine"),
            );
            await expect(fs.readFile(path.join(quarantine, "bin/rg"), "utf8")).resolves.toBe(
              "state legacy binary",
            );
            expect(result.warnings).toEqual([
              expect.stringContaining(path.join(quarantine, "bin/rg")),
            ]);
            expect((await detect()).agentDir.hasLegacy).toBe(false);

            await fs.mkdir(path.join(legacyDir, "bin"), { recursive: true });
            await fs.writeFile(path.join(legacyDir, "bin/fd"), "recreated SDK binary");
            expect(getAgentDir()).toBe(canonicalDir);
            expect((await detect()).preview).toContainEqual(expect.stringContaining(legacyDir));
          } finally {
            vi.unstubAllEnvs();
          }
        },
      );
    },
  );

  it("keeps standalone state until Doctor migrates it and reports recreated legacy state", async () => {
    await withOpenClawTestState(
      { label: "standalone-agent-cutover", agentEnv: "clear" },
      async (state) => {
        await state.writeText("agent/bin/fd", "legacy binary");
        const legacyDir = state.statePath("agent");
        const canonicalDir = state.agentDir();
        const detect = () =>
          detectLegacyStateMigrations({
            cfg: { agents: { entries: { main: {} } } },
            env: state.env,
            legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
          });

        await fs.mkdir(canonicalDir, { recursive: true });
        expect(getAgentDir()).toBe(legacyDir);
        await expect(fs.readdir(canonicalDir)).resolves.toEqual([]);
        if (process.platform !== "win32") {
          await fs.chmod(canonicalDir, 0o2750);
        }
        const sourceRoot = await fs.realpath(legacyDir);
        const detected = await detect();
        expect(detected.agentDir.targetDir).toBe(canonicalDir);
        const migrated = await migrateLegacyAgentDir(detected, () => 1234);
        expect(migrated.warnings).toEqual([]);
        if (process.platform !== "win32") {
          expect((await fs.stat(canonicalDir)).mode & 0o7777).toBe(0o2750);
        }
        const receipt = await fs.readFile(
          path.join(canonicalDir, ".legacy-agent-dir-migration.json"),
          "utf8",
        );
        expect(JSON.parse(receipt)).toEqual({
          version: 1,
          source: sourceRoot,
          target: await fs.realpath(canonicalDir),
        });
        expect(getAgentDir()).toBe(canonicalDir);
        await expect(fs.readFile(path.join(canonicalDir, "bin/fd"), "utf8")).resolves.toBe(
          "legacy binary",
        );

        await state.writeText("agent/bin/fd", "recreated binary");
        expect(getAgentDir()).toBe(canonicalDir);
        const leftover = await detect();
        expect(leftover.agentDir.hasLegacy).toBe(true);
        expect(leftover.preview).toContainEqual(expect.stringContaining(legacyDir));
        const result = await migrateLegacyAgentDir(leftover, () => 5678);
        expect(result.warningDisposition).toBe("recoverable");
        expect(result.warnings).toContainEqual(expect.stringContaining("quarantined legacy copy"));
        await expect(fs.readFile(path.join(canonicalDir, "bin/fd"), "utf8")).resolves.toBe(
          "legacy binary",
        );
        await expect(fs.stat(legacyDir)).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  });

  it("preserves an unrecognized destination receipt and reports incomplete cutover", async () => {
    await withOpenClawTestState(
      { label: "standalone-agent-receipt-collision", agentEnv: "clear" },
      async (state) => {
        await state.writeText("agent/bin/fd", "legacy binary");
        const receiptPath = state.statePath("agents/main/agent/.legacy-agent-dir-migration.json");
        await state.writeText(
          "agents/main/agent/.legacy-agent-dir-migration.json",
          "unrecognized receipt payload",
        );
        const detected = await detectLegacyStateMigrations({
          cfg: { agents: { entries: { main: {} } } },
          env: state.env,
          legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        });

        const result = await migrateLegacyAgentDir(detected, () => 1234);

        await expect(fs.readFile(receiptPath, "utf8")).resolves.toBe(
          "unrecognized receipt payload",
        );
        expect(result.warningDisposition).toBe("recoverable");
        expect(result.warnings).toContainEqual(expect.stringContaining(receiptPath));
        await expect(fs.readFile(path.join(state.agentDir(), "bin/fd"), "utf8")).resolves.toBe(
          "legacy binary",
        );
        expect(getAgentDir()).toBe(state.agentDir());
      },
    );
  });

  it.each([false, true])(
    "keeps standalone state after an incomplete migration, including a source-carried receipt (companion: %s)",
    async (companion) => {
      await withOpenClawTestState(
        { label: "standalone-agent-incomplete", agentEnv: "clear" },
        async (state) => {
          await state.writeText("agent/bin/fd", "legacy binary");
          const legacyDir = state.statePath("agent");
          const canonicalDir = state.agentDir();
          await fs.mkdir(canonicalDir, { recursive: true });
          const receiptName = ".legacy-agent-dir-migration.json";
          const receiptBytes =
            JSON.stringify({
              version: 1,
              source: await fs.realpath(legacyDir),
              target: await fs.realpath(canonicalDir),
            }) + "\n";
          await fs.writeFile(path.join(legacyDir, receiptName), receiptBytes);
          if (companion) {
            await fs.writeFile(path.join(legacyDir, `${receiptName}-wal`), "untrusted companion");
          }
          const detected = await detectLegacyStateMigrations({
            cfg: { agents: { entries: { main: {} } } },
            env: state.env,
            legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
          });
          const rename = fsSync.renameSync;
          const sourceBin = path.join(await fs.realpath(legacyDir), "bin");
          vi.spyOn(fsSync, "renameSync").mockImplementation((source, target) => {
            if (source === sourceBin) {
              throw new Error("synthetic binary move failure");
            }
            rename(source, target);
          });

          const copy = fsSync.cpSync;
          vi.spyOn(fsSync, "cpSync").mockImplementation((source, target, options) => {
            if (source === sourceBin) {
              throw new Error("synthetic binary move failure");
            }
            copy(source, target, options);
          });
          const result = await migrateLegacyAgentDir(detected, () => 1234);

          expect(result.warnings).toContainEqual(
            expect.stringContaining("synthetic binary move failure"),
          );
          expect(getAgentDir()).toBe(legacyDir);
          await expect(fs.readFile(path.join(legacyDir, "bin/fd"), "utf8")).resolves.toBe(
            "legacy binary",
          );
          await expect(fs.stat(path.join(canonicalDir, receiptName))).rejects.toMatchObject({
            code: "ENOENT",
          });
          if (companion) {
            expect(fsSync.existsSync(path.join(canonicalDir, `${receiptName}-wal`))).toBe(false);
            await expect(
              fs.readFile(path.join(legacyDir, `${receiptName}-wal`), "utf8"),
            ).resolves.toBe("untrusted companion");
          }
          await expect(fs.readFile(path.join(legacyDir, receiptName), "utf8")).resolves.toBe(
            receiptBytes,
          );
          vi.restoreAllMocks();
          const completed = await migrateLegacyAgentDir(detected, () => 5678);
          expect(completed.warnings).toContainEqual(expect.stringContaining(receiptName));
          const quarantines = (await fs.readdir(state.stateDir)).filter((name) =>
            name.startsWith("agent.legacy-"),
          );
          if (companion) {
            expect(completed.outcome).toBe("deferred");
            expect(quarantines).toHaveLength(0);
            expect(getAgentDir()).toBe(legacyDir);
            expect(fsSync.existsSync(path.join(canonicalDir, receiptName))).toBe(false);
            return;
          }
          expect(quarantines).toHaveLength(1);
          await expect(
            fs.readFile(
              state.statePath(expectDefined(quarantines[0], "receipt quarantine"), receiptName),
              "utf8",
            ),
          ).resolves.toBe(receiptBytes);
          await state.writeText("agent/bin/fd", "recreated binary");
          expect(getAgentDir()).toBe(canonicalDir);
        },
      );
    },
  );

  it.each(["external", "ancestor-symlink"])(
    "keeps conflict quarantines confined to state for an %s agent directory",
    async (layout) => {
      await withOpenClawTestState({ label: "agent-quarantine-boundary" }, async (state) => {
        const outside = path.join(state.root, "external");
        const physicalTarget = path.join(outside, "agent");
        await fs.mkdir(path.join(physicalTarget, "bin"), { recursive: true });
        await fs.writeFile(path.join(physicalTarget, "bin/rg"), "current binary");
        let targetDir = physicalTarget;
        if (layout === "ancestor-symlink") {
          const alias = state.statePath("linked");
          await fs.symlink(outside, alias, process.platform === "win32" ? "junction" : "dir");
          targetDir = path.join(alias, "agent");
        }
        await state.writeText("agent/bin/rg", "legacy binary");
        await state.writeText("agent/bin/fd", "missing binary");
        const detected = await detectLegacyStateMigrations({
          cfg: { agents: { entries: { main: { agentDir: targetDir } } } },
          env: state.env,
          legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        });

        const result = await migrateLegacyAgentDir(detected, () => 1234);

        const quarantines = (await fs.readdir(state.stateDir)).filter((name) =>
          name.startsWith("agent.legacy-"),
        );
        expect(quarantines).toHaveLength(1);
        const stateRoot = await fs.realpath(state.stateDir);
        const quarantine = path.join(
          stateRoot,
          expectDefined(quarantines[0], "confined quarantine"),
        );
        expect(await fs.realpath(path.dirname(quarantine))).toBe(stateRoot);
        expect(await fs.realpath(quarantine)).toBe(quarantine);
        expect(
          (await fs.readdir(outside)).filter((name) => name.startsWith("agent.legacy-")),
        ).toEqual([]);
        await expect(fs.readFile(path.join(quarantine, "bin/rg"), "utf8")).resolves.toBe(
          "legacy binary",
        );
        await expect(fs.readFile(path.join(physicalTarget, "bin/rg"), "utf8")).resolves.toBe(
          "current binary",
        );
        await expect(fs.readFile(path.join(physicalTarget, "bin/fd"), "utf8")).resolves.toBe(
          "missing binary",
        );
        expect(result.warningDisposition).toBe("recoverable");
        expect(result.warnings).toEqual([expect.stringContaining(path.join(quarantine, "bin/rg"))]);
      });
    },
  );

  it.each(["custom-agent", "agent"])(
    "honors the configured agent directory %s",
    async (directory) => {
      await withOpenClawTestState({ label: "legacy-agent-configured" }, async (state) => {
        await state.writeText("agent/settings.json", "legacy settings");
        const targetDir = state.statePath(directory);
        const detected = await detectLegacyStateMigrations({
          cfg: { agents: { entries: { main: { agentDir: targetDir } } } },
          env: state.env,
          legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        });
        expect(detected.agentDir.targetDir).toBe(targetDir);
        expect(detected.agentDir.hasLegacy).toBe(directory !== "agent");
        const result = await migrateLegacyAgentDir(detected, () => 1234);
        expect(result.warnings).toEqual([]);
        await expect(fs.readFile(path.join(targetDir, "settings.json"), "utf8")).resolves.toBe(
          "legacy settings",
        );
      });
    },
  );

  it("merges nested binaries, keeps destination bytes, and quarantines only conflicts once", async () => {
    await withOpenClawTestState({ label: "legacy-agent-merge" }, async (state) => {
      await state.writeText("agent/bin/rg", "legacy binary");
      await state.writeText("agent/bin/fd", "identical binary");
      await state.writeText("agent/bin/nested/tool", "missing tool");
      await state.writeText("agents/main/agent/bin/rg", "current binary");
      await state.writeText("agents/main/agent/bin/fd", "identical binary");
      const detect = () =>
        detectLegacyStateMigrations({
          cfg: { agents: { entries: { main: {} } } },
          env: state.env,
          legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        });

      const result = await migrateLegacyAgentDir(await detect(), () => 1234);

      await expect(fs.readFile(state.agentDir() + "/bin/nested/tool", "utf8")).resolves.toBe(
        "missing tool",
      );
      await expect(fs.readFile(state.agentDir() + "/bin/rg", "utf8")).resolves.toBe(
        "current binary",
      );
      await expect(fs.readFile(state.agentDir() + "/bin/fd", "utf8")).resolves.toBe(
        "identical binary",
      );
      const agentRoot = await fs.realpath(state.stateDir);
      const quarantines = (await fs.readdir(agentRoot)).filter((name) =>
        name.startsWith("agent.legacy-"),
      );
      expect(quarantines).toHaveLength(1);
      const quarantine = path.join(agentRoot, expectDefined(quarantines[0], "conflict quarantine"));
      await expect(fs.readFile(path.join(quarantine, "bin/rg"), "utf8")).resolves.toBe(
        "legacy binary",
      );
      expect(await fs.readdir(path.join(quarantine, "bin"))).toEqual(["rg"]);
      expect(result).toMatchObject({ warningDisposition: "recoverable" });
      expect(result.warnings).toEqual([expect.stringContaining(path.join(quarantine, "bin/rg"))]);
      expect(result.changes).toContainEqual(expect.stringContaining(path.join("bin", "nested")));
      await expect(fs.stat(state.statePath("agent"))).rejects.toMatchObject({ code: "ENOENT" });

      // An older binary can recreate an identical file between Doctor runs.
      await state.writeText("agent/bin/fd", "identical binary");
      const repeated = await migrateLegacyAgentDir(await detect(), () => 5678);
      expect(repeated.warnings).toEqual([]);
      expect(
        (await fs.readdir(agentRoot)).filter((name) => name.startsWith("agent.legacy-")),
      ).toEqual(quarantines);
    });
  });

  it("reports old quarantine artifacts without requiring a new legacy payload or deleting data", async () => {
    await withOpenClawTestState({ label: "legacy-agent-quarantine" }, async (state) => {
      await state.writeText("agent.legacy-1234/bin/rg", "preserved binary");
      await state.writeText("agents/main/agent.legacy-1234/bin/rg", "older layout binary");
      const detected = await detectLegacyStateMigrations({
        cfg: { agents: { entries: { main: {} } } },
        env: state.env,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
      expect(detected.agentDir.hasLegacy).toBe(false);
      expect(
        detected.notices?.filter((notice) => notice.includes("older than 30 days")),
      ).toHaveLength(2);
      await expect(fs.readFile(state.statePath("agent.legacy-1234/bin/rg"), "utf8")).resolves.toBe(
        "preserved binary",
      );
      await expect(
        fs.readFile(state.statePath("agents/main/agent.legacy-1234/bin/rg"), "utf8"),
      ).resolves.toBe("older layout binary");
    });
  });

  it("does not create another quarantine when an old runtime recreates identical binaries", async () => {
    await withOpenClawTestState({ label: "legacy-agent-repeat" }, async (state) => {
      await state.writeText("agent/bin/fd", "identical binary");
      await state.writeText("agents/main/agent/bin/fd", "identical binary");
      await state.writeText("agent.legacy-1234/bin/rg", "preserved binary");
      const detected = await detectLegacyStateMigrations({
        cfg: { agents: { entries: { main: {} } } },
        env: state.env,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
      await migrateLegacyAgentDir(detected, () => 5678);
      expect(
        (await fs.readdir(state.stateDir)).filter((name) => name.startsWith("agent.legacy-")),
      ).toEqual(["agent.legacy-1234"]);
      await expect(fs.stat(state.statePath("agent"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
