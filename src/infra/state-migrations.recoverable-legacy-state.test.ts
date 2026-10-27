import fsSync from "node:fs";
import fs from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { getAgentDir } from "../agents/config.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { writeFixtureTree as writeFiles } from "./fixture-tree.test-support.js";
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
import {
  expectFile,
  expectFiles,
  expectMissing,
  runPluginMigrations,
} from "./state-migrations.store.test-support.js";
import type { MigrationMessages } from "./state-migrations.types.js";

const receiptName = ".legacy-agent-dir-migration.json";
const agentConfig = { agents: { entries: { main: {} } }, plugins: { enabled: false } };

const withAgentState = (
  run: (state: OpenClawTestState) => Promise<void>,
  layout?: "home" | "split",
) => withOpenClawTestState({ label: "legacy-agent", agentEnv: "clear", layout }, run);

async function standaloneAgent(state: OpenClawTestState) {
  const legacyDir = state.statePath("agent");
  const canonicalDir = state.agentDir();
  await state.writeText("agent/bin/fd", "legacy binary");
  await fs.mkdir(canonicalDir, { recursive: true });
  const receipt = {
    version: 1,
    source: await fs.realpath(legacyDir),
    target: await fs.realpath(canonicalDir),
  };
  return { legacyDir, canonicalDir, receipt };
}

const detectAgentState = (
  state: { env: NodeJS.ProcessEnv },
  cfg: Parameters<typeof detectLegacyStateMigrations>[0]["cfg"] = { agents: agentConfig.agents },
  homedir?: () => string,
) =>
  detectLegacyStateMigrations({
    cfg,
    env: state.env,
    homedir,
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
  });

const listQuarantines = async (stateDir: string) =>
  (await fs.readdir(stateDir)).filter((name) => name.startsWith("agent.legacy-"));

async function onlyQuarantine(stateDir: string) {
  const quarantines = await listQuarantines(stateDir);
  expect(quarantines).toHaveLength(1);
  return path.join(stateDir, expectDefined(quarantines[0], "quarantine"));
}

function failOnSource<Args extends unknown[]>(
  original: (...args: Args) => void,
  source: Args[0],
  message: string,
) {
  return (...args: Args) => {
    if (args[0] === source) {
      throw new Error(message);
    }
    original(...args);
  };
}

function failUnlink(source: string, message: string) {
  const unlink = failOnSource(fsSync.unlinkSync, source, message);
  vi.spyOn(fsSync, "unlinkSync").mockImplementation(unlink);
}

function walRows(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT value FROM wal_proof").all();
  } finally {
    db.close();
  }
}

const expectWarning = (result: MigrationMessages, text: string) =>
  expect(result.warnings).toContainEqual(expect.stringContaining(text));

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

it.each([false, true])(
  "keeps Discord cache cleanup advisory with retired state=%s",
  (retiredState) =>
    withOpenClawTestState({ label: "discord-cache-cleanup" }, async ({ stateDir, env }) => {
      const discordDir = path.join(stateDir, "discord");
      const sourcePath = path.join(discordDir, "command-deploy-cache.json");
      const retiredPath = path.join(discordDir, "thread-bindings.json");
      await fs.mkdir(discordDir, { recursive: true });
      await fs.writeFile(sourcePath, "retired deploy hashes");
      if (retiredState) {
        await fs.writeFile(retiredPath, "{}");
      }
      failUnlink(sourcePath, "synthetic cache cleanup permission denied");
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

      const migrate = async () =>
        (await runPluginMigrations("discord", params)).map(({ id, result }) =>
          migrationReceipt(id, result),
        );
      const receipts = await migrate();
      const warnings = receipts.flatMap((receipt) => receipt.warnings).join("\n");

      await expectFile(sourcePath, "retired deploy hashes");
      expect(warnings).toContain("Discord command deployment cache");
      expect(warnings).toContain("synthetic cache cleanup permission denied");
      expect(receipts).toContainEqual(
        expect.objectContaining({ id: "discord-legacy-state", outcome: "warning" }),
      );
      if (retiredState) {
        expect(() => throwIfDoctorStateMigrationRefused(receipts)).toThrow(
          "Doctor stopped because a state migration refused",
        );
        expect(warnings).toContain(
          `Discord retired model preferences and thread bindings uses a retired pre-July 2026 format: ${retiredPath}. Install OpenClaw 2026.9.5. Run openclaw doctor --fix before upgrading to latest. Retired files were left untouched.`,
        );
        await expectFile(retiredPath, "{}");
      } else {
        expect(() => throwIfDoctorStateMigrationRefused(receipts)).not.toThrow();
        expect(warnings).toContain("openclaw doctor --fix");
      }
      vi.restoreAllMocks();
      if (!retiredState) {
        expect((await migrate()).flatMap((receipt) => receipt.warnings)).toEqual([]);
        await expectMissing(sourcePath);
      }
    }),
);

it("keeps a shared source blocked when another cleanup owner does not opt in", () =>
  withOpenClawTestState({ label: "shared-cleanup-policy" }, async ({ stateDir }) => {
    const sourcePath = path.join(stateDir, "shared-cache.json");
    await fs.writeFile(sourcePath, "retained source");
    failUnlink(sourcePath, "synthetic shared cleanup failure");

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
    await expectFile(sourcePath, "retained source");
  }));
it.each<{
  relativeDatabase: string;
  destination: "database" | "wal" | "empty";
  orphanSource?: boolean;
  copyFailure?: boolean;
}>([
  { relativeDatabase: "openclaw-agent.sqlite", destination: "database" },
  { relativeDatabase: "state/openclaw.sqlite", destination: "database" },
  { relativeDatabase: "cache.db", destination: "empty" },
  { relativeDatabase: "custom-store", destination: "wal" },
  { relativeDatabase: "sessions/transcripts.sqlite", destination: "empty", orphanSource: true },
  { relativeDatabase: "openclaw-agent.sqlite", destination: "empty", copyFailure: true },
])(
  "preserves SQLite families ($relativeDatabase, destination: $destination, copy failure: $copyFailure)",
  ({ relativeDatabase, destination, orphanSource, copyFailure }) =>
    withAgentState(async (state) => {
      const legacyDir = path.join(state.home, ".openclaw", "agent");
      const targetDir = state.agentDir("main");
      const sourceDatabase = path.join(legacyDir, relativeDatabase);
      const otherDatabase = path.join(legacyDir, "a-other.sqlite");
      const targetDatabase = path.join(targetDir, relativeDatabase);
      for (const directory of [path.dirname(sourceDatabase), path.dirname(targetDatabase)]) {
        await fs.mkdir(directory, { recursive: true });
      }
      await writeFiles(legacyDir, { "bin/fd": "installed", "bin/rg": "legacy" });
      await writeFiles(targetDir, { "bin/rg": "current" });
      const failedBinary = path.join(legacyDir, "bin/zz-fail");
      if (copyFailure) {
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
          fsSync.existsSync(file) ? fsSync.readFileSync(file) : null,
        );
      const originalDestination = destinationFiles();
      const walBytes = await fs.readFile(`${sourceDatabase}-wal`);
      expect(walBytes.length).toBeGreaterThan(32);
      const mainOnly = state.statePath("main-only.sqlite");
      await fs.copyFile(sourceDatabase, mainOnly);
      expect(walRows(mainOnly)).toEqual([]);
      if (orphanSource) {
        await fs.unlink(sourceDatabase);
      }
      const detect = () => detectAgentState(state, agentConfig, () => state.home);
      const detected = await detect();
      const families = [otherDatabase, sourceDatabase].map((database) => ({
        database,
        files: resolveSqliteDatabaseFilePaths(database).filter((file) => fsSync.existsSync(file)),
        destination: path.join(targetDir, path.relative(legacyDir, database)),
        outcome: "deferred",
        reason: "sqlite-family",
      }));
      const renameSpy = vi.spyOn(fsSync, "renameSync");
      const copy = fsSync.copyFileSync;
      const copySpy = vi.spyOn(fsSync, "copyFileSync").mockImplementation((from, to, mode) => {
        if (copyFailure && String(from) === failedBinary) {
          expect(fsSync.readFileSync(path.join(targetDir, "bin/fd"), "utf8")).toBe("installed");
          throw new Error("injected binary move failure");
        }
        copy(from, to, mode);
      });
      if (copyFailure) {
        // The fixture needs a successful copy before its controlled failure;
        // filesystem enumeration has no ordering guarantee.
        const readDirectory = fsSync.readdirSync;
        vi.spyOn(fsSync, "readdirSync").mockImplementation((directory, options) => {
          const entries = readDirectory.call(fsSync, directory, options);
          return String(directory) === path.join(legacyDir, "bin")
            ? entries.toSorted((left, right) => String(left.name).localeCompare(String(right.name)))
            : entries;
        });
      }
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
      expect(fsSync.existsSync(path.join(targetDir, receiptName))).toBe(false);
      expect(getAgentDir()).toBe(legacyDir);
      await expectFiles(targetDir, { "bin/fd": "installed", "bin/rg": "current" });
      await expectFiles(legacyDir, { "bin/fd": "installed", "bin/rg": "legacy" });
      expect(await listQuarantines(state.stateDir)).toEqual([]);
      const touchesFamily = (from: fsSync.PathLike) =>
        families.some((family) =>
          family.files.some(
            (file) => file === String(from) || file.startsWith(`${String(from)}${path.sep}`),
          ),
        );
      expect(renameSpy.mock.calls.some(([from]) => touchesFamily(from))).toBe(false);
      expect(copySpy.mock.calls.some(([from]) => touchesFamily(from))).toBe(false);
      if (copyFailure) {
        expect(receipt.warnings.join("\n")).toContain("injected binary move failure");
        await expectFile(failedBinary, "retained binary");
      }
      const repeated = migrationReceipt(
        "agent-dir",
        await migrateLegacyAgentDir(await detect(), () => 5678),
      );
      expect(repeated.sqliteFamilies).toEqual(receipt.sqliteFamilies);
      expect(await listQuarantines(state.stateDir)).toEqual([]);
      if (orphanSource) {
        await fs.copyFile(mainOnly, sourceDatabase);
      }
      for (const database of [sourceDatabase, otherDatabase]) {
        expect(await fs.readFile(`${database}-wal`)).toEqual(walBytes);
        expect(walRows(database)).toEqual([{ value: "legacy WAL row" }]);
      }
    }, "home"),
);

it("does not open unrelated SDK home payload in a copied snapshot", () =>
  withAgentState(async (state) => {
    const legacyDir = path.join(state.home, ".openclaw", "agent");
    await writeFiles(legacyDir, { "bin/fd": "uncopied SDK binary" });
    await state.writeConfig(agentConfig);
    const readDirectory = vi.spyOn(fsSync, "readdirSync");

    const plan = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: { root: process.cwd(), version: "test" },
      snapshot: { homeDir: state.home, stateDir: state.stateDir, configPath: state.configPath },
      env: state.env,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });

    expect(plan.warnings).not.toContainEqual(
      expect.stringContaining(`outside the copied state snapshot: ${legacyDir}`),
    );
    expect(readDirectory.mock.calls.some(([directory]) => directory === legacyDir)).toBe(false);
    expect(plan.steps.flatMap((step) => step.source)).not.toContainEqual({
      kind: "path",
      path: legacyDir,
    });
    await expectFile(path.join(legacyDir, "bin/fd"), "uncopied SDK binary");
  }, "split"));

it.each(["OPENCLAW_STATE_DIR", "OPENCLAW_HOME"])(
  "preserves unrelated SDK state with %s while migrating state-root files",
  (override) =>
    withAgentState(async (state) => {
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
        await writeFiles(legacyDir, { "bin/fd": "SDK binary" });
        await writeFiles(stateLegacyDir, { "bin/rg": "state legacy binary" });
        await writeFiles(canonicalDir, { "bin/rg": "current binary" });
        const detect = () => detectAgentState({ env });
        const detected = await detect();
        expect(detected.preview).not.toContainEqual(expect.stringContaining(legacyDir));
        expect(detected.preview).toContainEqual(expect.stringContaining(stateLegacyDir));
        expect(getAgentDir()).toBe(canonicalDir);
        const result = await migrateLegacyAgentDir(detected, () => 1234);

        expect(getAgentDir()).toBe(canonicalDir);
        await expectFile(path.join(legacyDir, "bin/fd"), "SDK binary");
        await expectMissing(path.join(canonicalDir, "bin/fd"));
        await expectFile(path.join(canonicalDir, "bin/rg"), "current binary");
        await expectMissing(path.join(canonicalDir, receiptName));
        await expectMissing(stateLegacyDir);
        const quarantine = await onlyQuarantine(stateDir);
        await expectFile(path.join(quarantine, "bin/rg"), "state legacy binary");
        expect(result.warnings).toEqual([expect.stringContaining(path.join(quarantine, "bin/rg"))]);
        expect((await detect()).agentDir.hasLegacy).toBe(false);
      } finally {
        vi.unstubAllEnvs();
      }
    }, "split"),
);

it("switches standalone state only after migration, reporting recreated state", () =>
  withAgentState(async (state) => {
    const { legacyDir, canonicalDir, receipt: expectedReceipt } = await standaloneAgent(state);
    const detect = () => detectAgentState(state);

    expect(getAgentDir()).toBe(legacyDir);
    await expect(fs.readdir(canonicalDir)).resolves.toEqual([]);
    if (process.platform !== "win32") {
      await fs.chown(canonicalDir, -1, userInfo().gid);
      await fs.chmod(canonicalDir, 0o2750);
      expect((await fs.stat(canonicalDir)).mode & 0o7777).toBe(0o2750);
    }
    const detected = await detect();
    expect(detected.agentDir.targetDir).toBe(canonicalDir);
    const migrated = await migrateLegacyAgentDir(detected, () => 1234);
    expect(migrated.warnings).toEqual([]);
    if (process.platform !== "win32") {
      expect((await fs.stat(canonicalDir)).mode & 0o7777).toBe(0o2750);
    }
    const receipt = await fs.readFile(path.join(canonicalDir, receiptName), "utf8");
    expect(JSON.parse(receipt)).toEqual(expectedReceipt);
    expect(getAgentDir()).toBe(canonicalDir);
    await expectFile(path.join(canonicalDir, "bin/fd"), "legacy binary");

    await state.writeText("agent/bin/fd", "recreated binary");
    expect(getAgentDir()).toBe(canonicalDir);
    const leftover = await detect();
    expect(leftover.agentDir.hasLegacy).toBe(true);
    expect(leftover.preview).toContainEqual(expect.stringContaining(legacyDir));
    const result = await migrateLegacyAgentDir(leftover, () => 5678);
    expect(result.warningDisposition).toBe("recoverable");
    expectWarning(result, "quarantined legacy copy");
    await expectFile(path.join(canonicalDir, "bin/fd"), "legacy binary");
    await expectMissing(legacyDir);
  }));

it("preserves an unknown destination receipt and reports incomplete cutover", () =>
  withAgentState(async (state) => {
    await state.writeText("agent/bin/fd", "legacy binary");
    const receiptPath = await state.writeText(
      `agents/main/agent/${receiptName}`,
      "unrecognized receipt payload",
    );
    const detected = await detectAgentState(state);

    const result = await migrateLegacyAgentDir(detected, () => 1234);

    await expectFile(receiptPath, "unrecognized receipt payload");
    expect(result.warningDisposition).toBe("recoverable");
    expectWarning(result, receiptPath);
    await expectFile(path.join(state.agentDir(), "bin/fd"), "legacy binary");
    expect(getAgentDir()).toBe(state.agentDir());
  }));

it.each([false, true])(
  "keeps standalone state after an incomplete migration, including a source-carried receipt (companion: %s)",
  (companion) =>
    withAgentState(async (state) => {
      const { legacyDir, canonicalDir, receipt } = await standaloneAgent(state);
      const receiptBytes = JSON.stringify(receipt) + "\n";
      await fs.writeFile(path.join(legacyDir, receiptName), receiptBytes);
      if (companion) {
        await fs.writeFile(path.join(legacyDir, `${receiptName}-wal`), "untrusted companion");
      }
      const detected = await detectAgentState(state);
      const sourceBin = path.join(await fs.realpath(legacyDir), "bin");
      const failure = "synthetic binary move failure";
      const rename = failOnSource(fsSync.renameSync, sourceBin, failure);
      const copy = failOnSource(fsSync.cpSync, sourceBin, failure);
      vi.spyOn(fsSync, "renameSync").mockImplementation(rename);
      vi.spyOn(fsSync, "cpSync").mockImplementation(copy);
      const result = await migrateLegacyAgentDir(detected, () => 1234);

      expectWarning(result, failure);
      expect(getAgentDir()).toBe(legacyDir);
      await expectFile(path.join(legacyDir, "bin/fd"), "legacy binary");
      await expectMissing(path.join(canonicalDir, receiptName));
      if (companion) {
        expect(fsSync.existsSync(path.join(canonicalDir, `${receiptName}-wal`))).toBe(false);
        await expectFile(path.join(legacyDir, `${receiptName}-wal`), "untrusted companion");
      }
      await expectFile(path.join(legacyDir, receiptName), receiptBytes);
      vi.restoreAllMocks();
      const completed = await migrateLegacyAgentDir(detected, () => 5678);
      expectWarning(completed, receiptName);
      const quarantines = await listQuarantines(state.stateDir);
      if (companion) {
        expect(completed.outcome).toBe("deferred");
        expect(quarantines).toHaveLength(0);
        expect(getAgentDir()).toBe(legacyDir);
        expect(fsSync.existsSync(path.join(canonicalDir, receiptName))).toBe(false);
        return;
      }
      expect(quarantines).toHaveLength(1);
      await expectFile(
        state.statePath(expectDefined(quarantines[0], "receipt quarantine"), receiptName),
        receiptBytes,
      );
      await state.writeText("agent/bin/fd", "recreated binary");
      expect(getAgentDir()).toBe(canonicalDir);
    }),
);

it("keeps conflict quarantines confined to state for an ancestor-symlink agent directory", () =>
  withOpenClawTestState({ label: "agent-quarantine-boundary" }, async (state) => {
    const outside = path.join(state.root, "external");
    const physicalTarget = path.join(outside, "agent");
    await writeFiles(physicalTarget, { "bin/rg": "current binary" });
    const alias = state.statePath("linked");
    await fs.symlink(outside, alias, process.platform === "win32" ? "junction" : "dir");
    await writeFiles(state.statePath("agent"), { "bin/rg": "legacy", "bin/fd": "missing" });
    const detected = await detectAgentState(state, {
      agents: { entries: { main: { agentDir: path.join(alias, "agent") } } },
    });

    const result = await migrateLegacyAgentDir(detected, () => 1234);

    const stateRoot = await fs.realpath(state.stateDir);
    const quarantine = await onlyQuarantine(stateRoot);
    expect(await fs.realpath(path.dirname(quarantine))).toBe(stateRoot);
    expect(await fs.realpath(quarantine)).toBe(quarantine);
    expect(await listQuarantines(outside)).toEqual([]);
    await expectFile(path.join(quarantine, "bin/rg"), "legacy");
    await expectFiles(physicalTarget, { "bin/rg": "current binary", "bin/fd": "missing" });
    expect(result).toMatchObject({
      warningDisposition: "recoverable",
      warnings: [expect.stringContaining(path.join(quarantine, "bin/rg"))],
    });
  }));

it("merges nested binaries, keeps destination bytes, and quarantines only conflicts once", () =>
  withOpenClawTestState({ label: "legacy-agent-merge" }, async (state) => {
    const binaries = { "bin/rg": "legacy", "bin/fd": "same", "bin/nested/tool": "missing" };
    await writeFiles(state.statePath("agent"), binaries);
    const expected = { ...binaries, "bin/rg": "current" };
    await writeFiles(state.agentDir(), { "bin/rg": "current", "bin/fd": "same" });
    const detect = () => detectAgentState(state);

    const result = await migrateLegacyAgentDir(await detect(), () => 1234);

    await expectFiles(state.agentDir(), expected);
    const agentRoot = await fs.realpath(state.stateDir);
    const quarantines = await listQuarantines(agentRoot);
    const quarantine = await onlyQuarantine(agentRoot);
    await expectFile(path.join(quarantine, "bin/rg"), "legacy");
    expect(await fs.readdir(path.join(quarantine, "bin"))).toEqual(["rg"]);
    expect(result).toMatchObject({
      warningDisposition: "recoverable",
      warnings: [expect.stringContaining(path.join(quarantine, "bin/rg"))],
      changes: expect.arrayContaining([expect.stringContaining(path.join("bin", "nested"))]),
    });
    await expectMissing(state.statePath("agent"));

    await state.writeText("agent/bin/fd", "same");
    const repeated = await migrateLegacyAgentDir(await detect(), () => 5678);
    expect(repeated.warnings).toEqual([]);
    expect(await listQuarantines(agentRoot)).toEqual(quarantines);
  }));

it("reports old quarantine artifacts without requiring a new legacy payload or deleting data", () =>
  withOpenClawTestState({ label: "legacy-agent-quarantine" }, async (state) => {
    const files = {
      "agent.legacy-1234/bin/rg": "preserved binary",
      "agents/main/agent.legacy-1234/bin/rg": "older layout binary",
    };
    await writeFiles(state.stateDir, files);
    const detected = await detectAgentState(state);
    expect(detected.agentDir.hasLegacy).toBe(false);
    expect(
      detected.notices?.filter((notice) => notice.includes("older than 30 days")),
    ).toHaveLength(2);
    await expectFiles(state.stateDir, files);
  }));
