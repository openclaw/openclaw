import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectRepointedWorkspaceAlias,
  rebindRepointedWorkspaceAlias,
} from "../agents/workspace-alias-rebind.js";
import { listAgentWorkspaceDirs } from "../agents/workspace-dirs.js";
import { assertNoUnmigratedWorkspaceState } from "../agents/workspace-legacy-state.js";
import { assertConfiguredWorkspaceStateReady } from "../agents/workspace-state-dirs.js";
import {
  createWorkspaceStateIdentity,
  resolveWorkspaceStateIdentity,
} from "../agents/workspace-state-identity.js";
import {
  WORKSPACE_CONTENT_RELOCATION_MIGRATION_KIND,
  WORKSPACE_LEGACY_STATE_MIGRATION_KIND,
  deleteWorkspaceState,
  prepareWorkspaceStateDeletion,
  readWorkspaceStateSnapshot,
} from "../agents/workspace-state-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import * as durability from "./directory-durability.js";
import {
  recordLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
} from "./state-migrations.receipts.js";
import {
  applyWorkspaceMigrationReceiptMove,
  createWorkspaceSetupFingerprint,
  prepareWorkspaceMigrationReceiptMove,
  readReceipt,
} from "./state-migrations.workspace-setup-receipts.js";
import {
  detectLegacyWorkspaceState,
  migrateLegacyWorkspaceState,
} from "./state-migrations.workspace-setup.js";
import { useWorkspaceMigrationTestFixture } from "./state-migrations.workspace-setup.test-support.js";

const HASH = "a".repeat(64);
const ATTESTED_AT = "2026-07-15T11:00:00.000Z";
const COMPLETED_AT = "2026-07-15T10:01:00.000Z";
const SEEDED_AT = "2026-07-15T10:00:00.000Z";
type Context = ReturnType<ReturnType<typeof useWorkspaceMigrationTestFixture>["setup"]>;
type MigrationContext = Omit<Context, "cfg"> & { cfg: OpenClawConfig };
type MigrationOverrides = Partial<Parameters<typeof migrateLegacyWorkspaceState>[0]>;
let context: Context;

async function write(file: string, contents: string) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, contents, "utf8");
}

const stateDb = () => openOpenClawStateDatabase({ env: context.env }).db;
const workspaceIdentity = () => resolveWorkspaceStateIdentity(context.workspaceDir);
const get = (sql: string, ...values: string[]) =>
  stateDb()
    .prepare(sql)
    .get(...values);

const setupPathFor = (workspace: string) => path.join(workspace, "openclaw-workspace-state.json");
const claimPathFor = (source: string) => `${source}.doctor-importing`;
const attestation = (generated = "", timestamp = ATTESTED_AT) =>
  `openclaw-workspace-attestation:v1\n${timestamp}\n${generated}`;
const setupSource = (fields: Record<string, string | number> = {}) =>
  JSON.stringify({ version: 1, ...fields });
const SETUP_MILESTONES = {
  version: 1,
  bootstrapSeededAt: SEEDED_AT,
  setupCompletedAt: COMPLETED_AT,
};
const COMPLETE_SETUP = JSON.stringify(SETUP_MILESTONES);

async function writeAttestation(file: string, generated = "", timestamp = ATTESTED_AT) {
  await write(file, attestation(generated, timestamp));
  const mtime = new Date(timestamp);
  await fsp.utimes(file, mtime, mtime);
  return mtime;
}

function expectFilesRemoved(...sources: string[]) {
  for (const source of sources) {
    expect([fs.existsSync(source), fs.existsSync(claimPathFor(source))]).toEqual([false, false]);
  }
}

function attestationPathFor(key = workspaceIdentity().workspaceKey) {
  return path.join(context.stateDir, "workspace-attestations", `${key}.attested`);
}

function readSetup(columns: string) {
  return get(
    `SELECT ${columns} FROM workspace_setup_state WHERE workspace_key = ?`,
    workspaceIdentity().workspaceKey,
  );
}

function readHashes(key = workspaceIdentity().workspaceKey) {
  return stateDb()
    .prepare(
      "SELECT filename, sha256 FROM workspace_generated_bootstrap_hashes WHERE workspace_key = ?",
    )
    .all(key);
}

function readReport(source: string) {
  const sql = "SELECT report_json FROM migration_sources WHERE source_path = ?";
  const receipt = get(sql, source) as { report_json: string };
  return JSON.parse(receipt.report_json) as { archivePath: string; differences?: unknown };
}

function interruptCleanup() {
  throw new Error("simulated unlink failure");
}

async function readContent(file: string) {
  const { uid, gid, mode } = await fsp.stat(file);
  return { bytes: await fsp.readFile(file), uid, gid, mode };
}

function assertReady() {
  assertNoUnmigratedWorkspaceState({ workspaceDir: context.workspaceDir });
}

function expectRetained(source: string) {
  expect([fs.existsSync(source), fs.existsSync(claimPathFor(source))]).toEqual([true, false]);
  expect(readSetup("workspace_key")).toBeUndefined();
}

describe("legacy workspace Doctor migration", () => {
  const { detect, setup } = useWorkspaceMigrationTestFixture();
  beforeEach(() => {
    context = setup();
  });
  afterEach(() => vi.restoreAllMocks());

  async function migrate(target: MigrationContext, overrides: MigrationOverrides = {}) {
    const { env, stateDir } = target;
    const detected = overrides.detected ?? (await detect(target));
    return migrateLegacyWorkspaceState({ detected, env, stateDir, ...overrides });
  }

  async function migrateOk(target: MigrationContext) {
    const result = await migrate(target);
    expect(result.warnings).toEqual([]);
    return result;
  }

  function aliasWorkspace(target: Context, workspaceAlias: string) {
    fs.symlinkSync(
      target.workspaceDir,
      workspaceAlias,
      process.platform === "win32" ? "junction" : "dir",
    );
    return {
      ...target,
      cfg: { agents: { defaults: { workspace: workspaceAlias } } } satisfies OpenClawConfig,
      workspaceDir: workspaceAlias,
    };
  }

  it("isolates receipts when a configured alias is repointed", async () => {
    const targetB = path.join(context.homeDir, "workspace-b");
    const workspaceAlias = path.join(context.homeDir, "workspace-link");
    fs.mkdirSync(targetB, { recursive: true });
    const aliasContext = aliasWorkspace(context, workspaceAlias);
    const sourcePath = `${workspaceAlias}.attested`;
    const identityA = workspaceIdentity();
    const attestedAtA = await writeAttestation(sourcePath);
    await migrateOk(aliasContext);
    fs.unlinkSync(workspaceAlias);
    fs.symlinkSync(targetB, workspaceAlias, process.platform === "win32" ? "junction" : "dir");
    await deleteWorkspaceState(prepareWorkspaceStateDeletion(workspaceAlias));
    const identityB = resolveWorkspaceStateIdentity(targetB);
    const attestedAtB = await writeAttestation(sourcePath, "", "2026-07-15T12:00:00.000Z");
    await migrateOk(aliasContext);
    const db = stateDb();
    expect(
      db
        .prepare(
          "SELECT workspace_key, attested_at_ms FROM workspace_setup_state ORDER BY workspace_key",
        )
        .all(),
    ).toEqual(
      [
        { workspace_key: identityA.workspaceKey, attested_at_ms: attestedAtA.getTime() },
        { workspace_key: identityB.workspaceKey, attested_at_ms: attestedAtB.getTime() },
      ].toSorted((left, right) => left.workspace_key.localeCompare(right.workspace_key)),
    );
    expect(
      get("SELECT COUNT(*) AS count FROM migration_sources WHERE source_path = ?", sourcePath),
    ).toEqual({ count: 2 });
  });

  it("rejects a configured workspace identity change before claiming a source", async () => {
    const targetB = path.join(context.homeDir, "workspace-b");
    const workspaceAlias = path.join(context.homeDir, "workspace-link");
    fs.mkdirSync(targetB, { recursive: true });
    const aliasContext = aliasWorkspace(context, workspaceAlias);
    const identityA = workspaceIdentity();
    const attestationPath = attestationPathFor(identityA.workspaceKey);
    await write(attestationPath, attestation());
    const detected = await detect(aliasContext);
    const result = await migrate(context, {
      detected,
      beforeClaim: () => {
        fs.unlinkSync(workspaceAlias);
        fs.symlinkSync(targetB, workspaceAlias, process.platform === "win32" ? "junction" : "dir");
      },
    });
    expect(result.warnings[0]).toContain("configured workspace identity changed");
    expectRetained(attestationPath);
    for (const table of ["workspace_setup_state", "migration_sources", "workspace_path_aliases"]) {
      expect(get(`SELECT COUNT(*) AS count FROM ${table}`)).toEqual({ count: 0 });
    }
  });

  it("imports configured and orphan sources only through explicit Doctor repair", async () => {
    const orphanKey = "c".repeat(64);
    const attestationPath = attestationPathFor(orphanKey);
    await write(attestationPath, attestation(`generated:TOOLS.md:${HASH}\n`));
    const setupPath = setupPathFor(context.workspaceDir);
    await write(setupPath, setupSource());
    expect(
      await detectLegacyWorkspaceState({
        cfg: context.cfg,
        stateDir: context.stateDir,
        env: context.env,
        homedir: () => context.homeDir,
      }),
    ).toEqual({ sources: [], hasLegacy: false });
    expect((await detect(context)).sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "setup", sourcePath: fs.realpathSync(setupPath) }),
        expect.objectContaining({ kind: "attestation", workspaceKey: orphanKey }),
      ]),
    );
    await migrateOk(context);
    expect(readHashes(orphanKey)).toEqual([{ filename: "TOOLS.md", sha256: HASH }]);
    expect(fs.existsSync(attestationPath)).toBe(false);
  });

  it("selects the highest-priority whole attestation across equal-time imports", async () => {
    const currentPath = attestationPathFor();
    const siblingPath = `${context.workspaceDir}.attested`;
    await writeAttestation(siblingPath, `generated:USER.md:${"b".repeat(64)}\n`);
    await migrateOk(context);
    await writeAttestation(currentPath, `generated:AGENTS.md:${HASH}\n`);
    await writeAttestation(siblingPath, `generated:TOOLS.md:${"b".repeat(64)}\n`);
    await migrateOk(context);
    expectFilesRemoved(currentPath, siblingPath);
    expect(readHashes()).toEqual([{ filename: "AGENTS.md", sha256: HASH }]);
  });

  it("resumes an interrupted unreceipted claim", async () => {
    const setupPath = setupPathFor(context.workspaceDir);
    const claimPath = claimPathFor(setupPath);
    await write(setupPath, JSON.stringify({ onboardingCompletedAt: COMPLETED_AT }));
    await fsp.rename(setupPath, claimPath);
    await migrateOk(context);
    expect(fs.existsSync(claimPath)).toBe(false);
    expect(readSetup("setup_completed_at")).toEqual({ setup_completed_at: COMPLETED_AT });
  });

  it.each(["symlink", "hardlink", "invalid-bootstrap-timestamp", "oversized-attestation"] as const)(
    "rejects %s without changing canonical state",
    async (kind) => {
      const setupPath = setupPathFor(context.workspaceDir);
      let sourcePath = setupPath;
      if (kind === "oversized-attestation") {
        const attestationPath = attestationPathFor();
        sourcePath = attestationPath;
        await write(attestationPath, attestation("x".repeat(3_000)));
      } else {
        const targetPath = path.join(context.workspaceDir, "target.json");
        await write(targetPath, setupSource());
        if (kind === "symlink") {
          await fsp.symlink(targetPath, setupPath);
        } else if (kind === "hardlink") {
          await fsp.link(targetPath, setupPath);
        } else if (kind === "invalid-bootstrap-timestamp") {
          await write(setupPath, setupSource({ bootstrapSeededAt: "2026-07-15T10:00:00Z" }));
        }
      }
      const result = await migrate(context);
      expect(result.warnings[0]).toMatch(/legacy workspace/i);
      for (const text of [
        sourcePath,
        "Stop the Gateway",
        ".rejected-<timestamp>",
        "openclaw doctor --fix",
      ]) {
        expect(result.warnings[0]).toContain(text);
      }
      expectRetained(sourcePath);
      if (kind === "invalid-bootstrap-timestamp") {
        const original = await fsp.readFile(sourcePath);
        const retainedPath = `${sourcePath}.rejected-2026-07-15T11-00-00`;
        expect(assertReady).toThrow(/requires migration/);
        await fsp.rename(sourcePath, retainedPath);
        expect(await fsp.readFile(retainedPath)).toEqual(original);
        expect((await detect(context)).hasLegacy).toBe(false);
        expect(await migrate(context)).toEqual({ changes: [], warnings: [] });
        expect(assertReady).not.toThrow();
      }
    },
  );

  it("discards an empty reserved hashed attestation and unblocks the workspace", async () => {
    const attestationPath = attestationPathFor();
    await write(attestationPath, "");
    expect((await detect(context)).hasLegacy).toBe(true);
    expect(assertReady).toThrow(/requires migration/);
    const result = await migrateOk(context);
    expect(result.changes[0]).toContain(attestationPath);
    expectFilesRemoved(attestationPath);
    expect((await detect(context)).hasLegacy).toBe(false);
    expect(assertReady).not.toThrow();
    expect(readSetup("workspace_key")).toBeUndefined();
  });

  it("restores an empty reserved hashed attestation that changes before claim", async () => {
    const attestationPath = attestationPathFor();
    await write(attestationPath, "");
    const replacementPath = path.join(context.homeDir, "empty-attestation-replacement");
    await write(replacementPath, "");
    const replacementInode = fs.statSync(replacementPath).ino;
    const originalInode = fs.statSync(attestationPath).ino;
    const result = await migrate(context, {
      beforeClaim: (source) => {
        if (source.sourcePath === attestationPath) {
          fs.renameSync(replacementPath, attestationPath);
        }
      },
    });
    expect(result.warnings[0]).toContain(attestationPath);
    expect(result.warnings[0]).toMatch(/changed before Doctor could claim/i);
    expectRetained(attestationPath);
    expect(fs.statSync(attestationPath).ino).toBe(replacementInode);
    expect(fs.statSync(attestationPath).ino).not.toBe(originalInode);
  });

  it("retains an empty workspace-sibling file and does not treat it as reserved state", async () => {
    const siblingPath = `${context.workspaceDir}.attested`;
    await write(siblingPath, "");
    expect((await detect(context)).hasLegacy).toBe(false);
    await migrateOk(context);
    expect(fs.existsSync(siblingPath)).toBe(true);
    expect(assertReady).not.toThrow();
  });

  it("rejects attestation beneath a symlinked parent", async () => {
    const externalDir = path.join(context.homeDir, "external-state");
    const identity = workspaceIdentity();
    const externalSource = path.join(externalDir, `${identity.workspaceKey}.attested`);
    const raw = attestation();
    await write(externalSource, raw);
    await fsp.mkdir(context.stateDir, { recursive: true });
    await fsp.symlink(externalDir, path.join(context.stateDir, "workspace-attestations"));
    expect((await detect(context)).hasLegacy).toBe(true);
    const result = await migrate(context);
    expect(result.warnings[0]).toMatch(/legacy workspace/i);
    await expect(fsp.readFile(externalSource, "utf8")).resolves.toBe(raw);
    expect(fs.existsSync(`${externalSource}.doctor-importing`)).toBe(false);
    expect(readSetup("workspace_key")).toBeUndefined();
  });

  it("retains a setup source that changes before Doctor claims it", async () => {
    const setupPath = setupPathFor(context.workspaceDir);
    await write(setupPath, setupSource());
    const result = await migrate(context, {
      beforeClaim: () => {
        fs.writeFileSync(setupPath, setupSource({ setupCompletedAt: "2026-07-16T00:00:00.000Z" }));
      },
    });
    expect(result.warnings[0]).toContain("changed before Doctor could claim it");
    expectRetained(setupPath);
  });

  it.each(["old", "conflicting"])(
    "uses receipts for idempotent cleanup-only retries (%s receipt)",
    async (kind) => {
      const conflicting = kind === "conflicting";
      const identity = workspaceIdentity();
      const setupPath = setupPathFor(context.workspaceDir);
      const seededAt = "2026-07-15T00:00:00.000Z";
      const raw = setupSource({ bootstrapSeededAt: seededAt });
      const claimPath = claimPathFor(setupPath);
      const canonicalSeededAt = conflicting ? "2026-07-14T00:00:00.000Z" : seededAt;
      if (conflicting) {
        stateDb()
          .prepare(
            "INSERT INTO workspace_setup_state (workspace_key, workspace_path, version, bootstrap_seeded_at, updated_at) VALUES (?, ?, 1, ?, 1)",
          )
          .run(identity.workspaceKey, identity.workspacePath, canonicalSeededAt);
      }
      await write(setupPath, raw);
      const first = await migrate(context, { removeSource: interruptCleanup });
      expect(first.warnings[0]).toContain("legacy cleanup failed");
      expect(first.warnings[0]).toContain(setupPath);
      expect(fs.existsSync(claimPath)).toBe(true);
      await write(claimPath, "{invalid");
      const unreadable = await migrate(context);
      expect(unreadable.warnings[0]).toContain(setupPath);
      expect(unreadable.warnings[0]).toContain("invalid JSON");
      expect(await fsp.readFile(claimPath, "utf8")).toBe("{invalid");
      await write(claimPath, raw);
      const receiptDb = stateDb();
      const oldReport = readReport(setupPath);
      const archivePath = oldReport.archivePath;
      await expect(fsp.readFile(archivePath, "utf8")).resolves.toBe(raw);
      if (kind === "old") {
        const { archivePath: _archive, differences: _differences, ...legacyReport } = oldReport;
        receiptDb
          .prepare("UPDATE migration_sources SET report_json = ? WHERE source_path = ?")
          .run(JSON.stringify(legacyReport), setupPath);
      } else {
        await write(archivePath, "partial backup");
        const corruptBackup = await migrate(context);
        expect(corruptBackup.warnings[0]).toContain("backup differs from the claimed source");
        expect(fs.existsSync(claimPath)).toBe(true);
        await write(archivePath, raw);
      }
      await migrateOk(context);
      const finalArchive = readReport(setupPath).archivePath;
      expect(finalArchive === archivePath).toBe(kind !== "old");
      await expect(fsp.readFile(finalArchive, "utf8")).resolves.toBe(raw);
      expect(fs.existsSync(claimPath)).toBe(false);
      expect(readSetup("bootstrap_seeded_at")).toEqual({ bootstrap_seeded_at: canonicalSeededAt });
      expect(
        get(
          "SELECT source_sha256, removed_source FROM migration_sources WHERE source_path = ?",
          setupPathFor(identity.workspacePath),
        ),
      ).toEqual({
        source_sha256: createHash("sha256").update(raw).digest("hex"),
        removed_source: 1,
      });
    },
  );

  it("retains a receipt-covered attestation when only its modification time changed", async () => {
    const attestationPath = attestationPathFor();
    await write(attestationPath, attestation());
    const originalMtime = new Date("2026-07-15T11:01:00.000Z");
    await fsp.utimes(attestationPath, originalMtime, originalMtime);
    const first = await migrate(context, { removeSource: interruptCleanup });
    expect(first.warnings[0]).toContain("legacy cleanup failed");
    const claimPath = claimPathFor(attestationPath);
    const changedMtime = new Date("2026-07-15T11:02:00.000Z");
    await fsp.utimes(claimPath, changedMtime, changedMtime);
    const retry = await migrate(context);
    expect(retry.warnings[0]).toContain("retired source now conflicts");
    expect(fs.existsSync(claimPath)).toBe(true);
    expect(readSetup("attested_at_ms")).toEqual({ attested_at_ms: originalMtime.getTime() });
  });

  it("imports shared-root setup for an explicit fleet without moving content", async () => {
    const cfg = {
      ...context.cfg,
      agents: {
        ...context.cfg.agents,
        ownership: "explicit" as const,
        entries: { main: {}, other: {} },
      },
    };
    const originalConfig = structuredClone(cfg);
    const effectiveDirs = listAgentWorkspaceDirs(cfg, context.env);
    const corpus = ["SOUL.md", "memory/retained.md"];
    const originalCorpus = await Promise.all(
      corpus.map(async (relativePath) => {
        const filePath = path.join(context.workspaceDir, relativePath);
        await write(filePath, `Retained ${relativePath}\n`);
        return readContent(filePath);
      }),
    );
    const rootPath = setupPathFor(context.workspaceDir);
    await write(rootPath, COMPLETE_SETUP);
    expect(effectiveDirs).toEqual(
      ["main", "other"].map((id) => path.join(context.workspaceDir, id)),
    );
    // An unused shared root is a Doctor source, not a runtime admission requirement.
    await expect(
      assertConfiguredWorkspaceStateReady({ cfg, env: context.env }),
    ).resolves.toBeUndefined();
    await migrateOk({ ...context, cfg });
    expect(fs.existsSync(rootPath)).toBe(false);
    expect(readSetup("bootstrap_seeded_at, setup_completed_at")).toEqual({
      bootstrap_seeded_at: SEEDED_AT,
      setup_completed_at: COMPLETED_AT,
    });
    expect(cfg).toEqual(originalConfig);
    for (const [index, relativePath] of corpus.entries()) {
      const filePath = path.join(context.workspaceDir, relativePath);
      expect(await readContent(filePath)).toEqual(originalCorpus[index]);
    }
    expect(await detect({ ...context, cfg })).toEqual({ sources: [], hasLegacy: false });
    expect(await migrate({ ...context, cfg })).toEqual({ changes: [], warnings: [] });
  });
  it("imports setup and attestation state, records receipts, and removes files", async () => {
    const workspaces = ["alpha", "beta", "gamma"].map((id) => ({
      id,
      workspace: path.join(context.homeDir, `workspace-${id}`),
    }));
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: Object.fromEntries(workspaces.map(({ id, workspace }) => [id, { workspace }])),
      },
    };
    const mtime = new Date("2026-07-15T11:02:03.456Z");
    const sources: string[] = [];
    for (const { workspace } of workspaces) {
      const setupPath = setupPathFor(workspace);
      await write(setupPath, COMPLETE_SETUP);
      sources.push(setupPath);
      const identity = resolveWorkspaceStateIdentity(workspace);
      const attestationPath = attestationPathFor(identity.workspaceKey);
      await write(attestationPath, attestation(`generated:AGENTS.md:${HASH}\n`));
      await fsp.utimes(attestationPath, mtime, mtime);
      sources.push(attestationPath);
    }
    const result = await migrateOk({ ...context, cfg });
    expect(result.changes).toHaveLength(sources.length);
    expectFilesRemoved(...sources);
    for (const { workspace } of workspaces) {
      const identity = resolveWorkspaceStateIdentity(workspace);
      expect(
        get(
          "SELECT workspace_path FROM workspace_setup_state WHERE workspace_key = ?",
          identity.workspaceKey,
        ),
      ).toEqual({ workspace_path: identity.workspacePath });
      expect(readHashes(identity.workspaceKey)).toEqual([{ filename: "AGENTS.md", sha256: HASH }]);
      expect(await readWorkspaceStateSnapshot(workspace)).toMatchObject({
        identity,
        setup: { bootstrapSeededAt: SEEDED_AT, setupCompletedAt: COMPLETED_AT },
        attestation: { attestedAtMs: mtime.getTime() },
      });
      expect(() => assertNoUnmigratedWorkspaceState({ workspaceDir: workspace })).not.toThrow();
    }
    expect(
      get(
        "SELECT COUNT(*) AS count, SUM(removed_source) AS removed FROM migration_sources WHERE migration_kind = ?",
        "legacy-workspace-setup-files",
      ),
    ).toEqual({ count: sources.length, removed: sources.length });
    expect(await migrate({ ...context, cfg })).toEqual({ changes: [], warnings: [] });
  });
  it.skipIf(process.platform === "win32")(
    "preserves the source until its archive directory can be synchronized",
    async () => {
      const source = setupPathFor(context.workspaceDir);
      const raw = `${setupSource({ setupCompletedAt: COMPLETED_AT })}\n`;
      fs.writeFileSync(source, raw);
      const pinDirectory = durability.pinDirectory;
      const pin = vi.spyOn(durability, "pinDirectory").mockImplementation(async (...args) => {
        const directory = await pinDirectory(...args);
        vi.spyOn(directory, "sync").mockResolvedValue({ status: "unsupported", code: "EINVAL" });
        return directory;
      });

      const refused = await migrate(context);
      expect(refused.warnings).toEqual([
        expect.stringContaining("Workspace setup archive directory does not support"),
      ]);
      expect(fs.readFileSync(source, "utf8")).toBe(raw);
      expect(fs.existsSync(`${source}.doctor-importing`)).toBe(false);
      expect(assertReady).toThrow();
      pin.mockRestore();
      await migrateOk(context);
      expect(fs.existsSync(source)).toBe(false);
      expect(await readWorkspaceStateSnapshot(context.workspaceDir)).toMatchObject({
        setup: { setupCompletedAt: COMPLETED_AT },
      });
    },
  );

  it.each([false, true])(
    "settles an interrupted source/claim link without replaying state (receipt=%s)",
    async (receiptExists) => {
      const source = setupPathFor(context.workspaceDir);
      const claim = claimPathFor(source);
      const raw = `${setupSource({ setupCompletedAt: COMPLETED_AT })}\n`;
      await write(source, raw);
      if (receiptExists) {
        const first = await migrate(context, { removeSource: interruptCleanup });
        expect(first.warnings).toHaveLength(1);
        fs.linkSync(claim, source);
      } else {
        fs.linkSync(source, claim);
      }
      await migrateOk(context);
      expectFilesRemoved(source);
      expect(assertReady).not.toThrow();
      expect(await readWorkspaceStateSnapshot(context.workspaceDir)).toMatchObject({
        setup: { setupCompletedAt: COMPLETED_AT },
      });
      const archives = fs.readdirSync(path.dirname(source));
      expect(archives).toHaveLength(1);
      expect(archives[0]).toMatch(/^openclaw-workspace-state\.json\.migrated\./);
      expect(fs.readFileSync(path.join(path.dirname(source), archives[0]!), "utf8")).toBe(raw);
    },
  );

  it("cleans a covered setup marker recreated after completed migration", async () => {
    const source = setupPathFor(context.workspaceDir);
    await write(source, COMPLETE_SETUP);
    await migrateOk(context);
    const raw = setupSource({ setupCompletedAt: COMPLETED_AT });
    await write(source, raw);
    await migrateOk(context);
    expect(fs.existsSync(source)).toBe(false);
    expect(readSetup("bootstrap_seeded_at, setup_completed_at")).toEqual({
      bootstrap_seeded_at: SEEDED_AT,
      setup_completed_at: COMPLETED_AT,
    });
    expect(get("SELECT * FROM migration_sources WHERE source_path = ?", source)).toMatchObject({
      source_sha256: createHash("sha256").update(raw).digest("hex"),
      removed_source: 1,
    });
    expect(readReport(source)).toMatchObject({ authoritative: true, resolution: "verified" });
  });

  it.each(["source", "claim", "collision"] as const)(
    "handles a recreated attestation: %s",
    async (mode) => {
      const source = attestationPathFor();
      const claim = claimPathFor(source);
      const original = attestation();
      const recreated = attestation("", "2026-07-16T11:00:00.000Z");
      const originalMtime = new Date("2026-07-15T11:01:00.000Z");
      const recreatedMtime = new Date("2026-07-16T11:01:00.000Z");
      const seed = async (raw: string, mtime: Date) => {
        await write(source, raw);
        await fsp.utimes(source, mtime, mtime);
      };
      await seed(original, originalMtime);
      await migrateOk(context);
      await seed(recreated, recreatedMtime);
      if (mode === "claim") {
        await fsp.rename(source, claim);
      } else if (mode === "collision") {
        await write(claim, recreated);
      }
      const collision = mode === "collision";
      expect((await migrate(context)).warnings).toEqual(
        collision
          ? ["Workspace state is in SQLite, but source and interrupted claim both exist."]
          : [],
      );
      expect([fs.existsSync(source), fs.existsSync(claim)]).toEqual([collision, collision]);
      expect(readSetup("attested_at_ms")).toEqual({
        attested_at_ms: (collision ? originalMtime : recreatedMtime).getTime(),
      });
      expect(get("SELECT * FROM migration_sources WHERE source_path = ?", source)).toMatchObject({
        source_sha256: createHash("sha256")
          .update(collision ? original : recreated)
          .digest("hex"),
        removed_source: 1,
      });
    },
  );
  it.each(["normal", "interrupted", "removed backup", "decomposed target", "decomposed source"])(
    "preserves migration history after a move: %s",
    async (mode) => {
      const interrupted = mode === "interrupted";
      const removeBackup = mode === "removed backup";
      const { env } = context;
      if (mode === "decomposed source") {
        const original = path.join(context.homeDir, "original-e\u0301");
        fs.renameSync(context.workspaceDir, original);
        context.workspaceDir = original;
      }
      const alias = path.join(context.homeDir, "workspace-alias");
      const moved = path.join(
        context.homeDir,
        mode === "decomposed target" ? "moved-e\u0301" : "moved-workspace",
      );
      const configured = aliasWorkspace(context, alias);
      const milestones = SETUP_MILESTONES;
      const raw = COMPLETE_SETUP;
      const sourcePath = setupPathFor(context.workspaceDir);
      fs.writeFileSync(sourcePath, raw);
      const detected = await detect(configured);
      const source = detected.sources.find((entry) => entry.kind === "setup")!;
      const imported = await migrateLegacyWorkspaceState({
        detected,
        env,
        stateDir: context.stateDir,
        removeSource: interrupted
          ? () => {
              throw new Error("interrupted cleanup");
            }
          : undefined,
      });
      expect(imported.warnings).toHaveLength(interrupted ? 1 : 0);
      const originalReceipt = readReceipt(source, env)!;
      expect(originalReceipt.removedSource).toBe(!interrupted);
      if (removeBackup) {
        fs.unlinkSync(originalReceipt.archivePath!);
      }
      const { db } = openOpenClawStateDatabase({ env });
      const readRuns = () => db.prepare("SELECT * FROM migration_runs ORDER BY id").all();
      const runs = readRuns();

      fs.renameSync(context.workspaceDir, moved);
      fs.unlinkSync(alias);
      fs.symlinkSync(moved, alias, process.platform === "win32" ? "junction" : "dir");
      const facts = detectRepointedWorkspaceAlias(alias, { env })!;
      expect(await rebindRepointedWorkspaceAlias(alias, facts, { env })).toBe("rebound");

      const identity = resolveWorkspaceStateIdentity(moved);
      const movedSource = {
        ...source,
        sourcePath: path.join(moved, "openclaw-workspace-state.json"),
        workspaceKey: identity.workspaceKey,
      };
      const receipt = readReceipt(movedSource, env);
      expect(receipt).toMatchObject({
        sha256: originalReceipt.sha256,
        removedSource: !interrupted,
        archivePath: expect.stringContaining(moved),
      });
      expect(fs.existsSync(receipt!.archivePath!)).toBe(!removeBackup);
      if (!removeBackup) {
        expect(fs.readFileSync(receipt!.archivePath!, "utf8")).toBe(raw);
      }
      expect(readRuns()).toEqual(runs);
      expect((await readWorkspaceStateSnapshot(alias)).setup).toEqual(milestones);
      const row = db
        .prepare("SELECT report_json FROM migration_sources WHERE source_key = ?")
        .get(receipt!.sourceKey)!;
      const canonical = JSON.stringify({
        kind: "setup",
        workspacePath: identity.workspacePath,
        ...milestones,
      });
      expect(JSON.parse(String(row.report_json))).toMatchObject({
        authoritative: true,
        canonicalFingerprint: createHash("sha256").update(canonical).digest("hex"),
      });

      const expectSettled = async () => {
        expect((await migrate(configured)).warnings).toEqual([]);
        expect((await readWorkspaceStateSnapshot(alias)).setup).toEqual(milestones);
        expect(readReceipt(movedSource, env)?.removedSource).toBe(true);
      };
      await expectSettled();
      expect(fs.existsSync(`${movedSource.sourcePath}.doctor-importing`)).toBe(false);
      expect(fs.existsSync(receipt!.archivePath!)).toBe(!removeBackup);

      // A removed source may have a later generation. The moved receipt must
      // preserve that distinction without replaying its replacement milestones.
      fs.writeFileSync(movedSource.sourcePath, '{"setupCompletedAt":"2026-07-16T00:00:00.000Z"}');
      await expectSettled();
    },
  );

  describe("workspace migration receipt move", () => {
    function fixture() {
      const storedIdentity = resolveWorkspaceStateIdentity(context.workspaceDir);
      const currentIdentity = createWorkspaceStateIdentity(
        path.join(path.dirname(storedIdentity.workspacePath), "moved-workspace"),
      );
      fs.renameSync(context.workspaceDir, currentIdentity.workspacePath);
      const { db: database } = openOpenClawStateDatabase({ env: context.env });
      const transact = (mutate: (db: typeof database) => void) =>
        runOpenClawStateWriteTransaction(({ db }) => mutate(db), { env: context.env });
      const storedSetup = {
        version: 1,
        workspace_path: storedIdentity.workspacePath,
        bootstrap_seeded_at: SEEDED_AT,
        setup_completed_at: COMPLETED_AT,
      };
      const sourcePath = setupPathFor(storedIdentity.workspacePath);
      const receipt = {
        sourceKey: resolveLegacyMigrationSourceKey(
          "workspace-setup",
          sourcePath,
          storedIdentity.workspaceKey,
        ),
        migrationKind: WORKSPACE_LEGACY_STATE_MIGRATION_KIND,
        sourcePath,
        targetTable: "workspace_setup_state",
        sourceSha256: "a".repeat(64),
        sourceSizeBytes: 10,
        sourceRecordCount: 1,
        runId: "setup-import",
        now: 1000,
        reportJson: JSON.stringify({
          sourceKind: "setup",
          workspaceKey: storedIdentity.workspaceKey,
          canonicalFingerprint: createWorkspaceSetupFingerprint(storedSetup),
          authoritative: true,
          resolution: "inserted",
        }),
      };
      transact((db) => {
        recordLegacyMigrationReceipt(db, receipt);
        db.prepare("UPDATE migration_sources SET removed_source = 1 WHERE source_key = ?").run(
          receipt.sourceKey,
        );
      });
      const params = {
        database,
        storedIdentity,
        currentIdentity,
        storedSetup,
        currentDirectoryPath: currentIdentity.workspacePath,
      };
      const rows = () =>
        database.prepare("SELECT * FROM migration_sources ORDER BY source_key").all();
      return {
        ...context,
        ...params,
        db: database,
        receipt,
        rows,
        transact,
        prepare: () => prepareWorkspaceMigrationReceiptMove(params),
        apply: (plan: Awaited<ReturnType<typeof prepareWorkspaceMigrationReceiptMove>>) =>
          transact((db) => applyWorkspaceMigrationReceiptMove(db, plan)),
      };
    }

    it.each(["changed", "added", "destination collision"] as const)(
      "refuses %s receipts without applying a partial move",
      async (change) => {
        const value = fixture();
        const plan = await value.prepare();
        if (change === "changed") {
          value.db
            .prepare("UPDATE migration_sources SET removed_source = 0 WHERE source_key = ?")
            .run(value.receipt.sourceKey);
        } else {
          const sourcePath =
            change === "added"
              ? path.join(value.storedIdentity.workspacePath, ".openclaw", "workspace-state.json")
              : setupPathFor(value.currentIdentity.workspacePath);
          const owner = change === "added" ? value.storedIdentity : value.currentIdentity;
          value.transact((db) =>
            recordLegacyMigrationReceipt(db, {
              ...value.receipt,
              sourcePath,
              sourceKey: resolveLegacyMigrationSourceKey(
                "workspace-setup",
                sourcePath,
                owner.workspaceKey,
              ),
              runId: "concurrent-import",
              reportJson: JSON.stringify({
                ...JSON.parse(value.receipt.reportJson),
                workspaceKey: owner.workspaceKey,
              }),
            }),
          );
        }
        const before = value.rows();
        expect(() =>
          value.transact((db) => {
            db.prepare("UPDATE migration_runs SET status = 'moving' WHERE id = ?").run(
              value.receipt.runId,
            );
            applyWorkspaceMigrationReceiptMove(db, plan);
          }),
        ).toThrow("migration history changed");
        expect(value.rows()).toEqual(before);
        expect(
          value.db
            .prepare("SELECT status FROM migration_runs WHERE id = ?")
            .get(value.receipt.runId),
        ).toEqual({ status: "completed" });
      },
    );

    it.each(["prepared", "completed", "superseded"])(
      "keeps %s skill-relocation evidence under its lifecycle owner",
      async (status) => {
        const value = fixture();
        const sourceKey = resolveLegacyMigrationSourceKey(
          WORKSPACE_CONTENT_RELOCATION_MIGRATION_KIND,
          value.storedIdentity.workspacePath,
        );
        const report = {
          ...value.storedIdentity,
          workspaceDir: value.storedIdentity.workspacePath,
          directoryIdentity: "1:2:3",
          attestedAtMs: 1000,
          moves: [
            {
              source: path.join(value.storedIdentity.workspacePath, "skills", "local-skill"),
              destination: path.join(value.homeDir, "workshop"),
              sha256: "b".repeat(64),
            },
          ],
        };
        value.transact((db) => {
          recordLegacyMigrationReceipt(db, {
            ...value.receipt,
            sourceKey,
            sourcePath: value.storedIdentity.workspacePath,
            migrationKind: WORKSPACE_CONTENT_RELOCATION_MIGRATION_KIND,
            runId: "skill-relocation",
            reportJson: JSON.stringify(report),
          });
          db.prepare("UPDATE migration_sources SET status = ? WHERE source_key = ?").run(
            status,
            sourceKey,
          );
        });
        const before = value.rows();
        const runs = value.db.prepare("SELECT * FROM migration_runs ORDER BY id").all();
        if (status === "prepared") {
          await expect(value.prepare()).rejects.toThrow("relocation is still pending");
          expect(value.rows()).toEqual(before);
          return;
        }
        value.apply(await value.prepare());
        const moved = value.db
          .prepare(
            "SELECT status, removed_source, report_json FROM migration_sources WHERE migration_kind = ?",
          )
          .get(WORKSPACE_CONTENT_RELOCATION_MIGRATION_KIND)!;
        expect(moved).toMatchObject({ status, removed_source: 0 });
        expect(JSON.parse(String(moved.report_json))).toEqual({
          ...report,
          workspaceKey: value.currentIdentity.workspaceKey,
        });
        expect(value.db.prepare("SELECT * FROM migration_runs ORDER BY id").all()).toEqual(runs);
      },
    );

    it("preserves an old unmatched fingerprint instead of granting it current authority", async () => {
      const value = fixture();
      const historical = {
        ...JSON.parse(value.receipt.reportJson),
        canonicalFingerprint: "b".repeat(64),
      };
      value.db
        .prepare("UPDATE migration_sources SET report_json = ? WHERE source_key = ?")
        .run(JSON.stringify(historical), value.receipt.sourceKey);
      value.apply(await value.prepare());
      expect(JSON.parse(String(value.rows()[0]!.report_json))).toMatchObject({
        canonicalFingerprint: historical.canonicalFingerprint,
        authoritative: true,
      });
    });

    it.each(["unfinished", "reappeared"])(
      "refuses an %s external source without losing its cleanup evidence",
      async (kind) => {
        const value = fixture();
        const sourcePath = path.join(
          value.stateDir,
          "workspace-attestations",
          `${value.storedIdentity.workspaceKey}.attested`,
        );
        const sourceKey = resolveLegacyMigrationSourceKey(
          "workspace-attestation",
          sourcePath,
          value.storedIdentity.workspaceKey,
        );
        value.db
          .prepare(
            "UPDATE migration_sources SET source_key = ?, source_path = ?, removed_source = ?, report_json = ? WHERE source_key = ?",
          )
          .run(
            sourceKey,
            sourcePath,
            kind === "unfinished" ? 0 : 1,
            JSON.stringify({ ...JSON.parse(value.receipt.reportJson), sourceKind: "attestation" }),
            value.receipt.sourceKey,
          );
        if (kind === "reappeared") {
          fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
          fs.writeFileSync(`${sourcePath}.doctor-importing`, "retained claim");
        }
        const before = value.rows();
        await expect(value.prepare()).rejects.toThrow(
          "external legacy source has not finished cleanup",
        );
        expect(value.rows()).toEqual(before);
      },
    );
  });
});
