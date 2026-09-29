import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listAgentWorkspaceDirs } from "../agents/workspace-dirs.js";
import { assertNoUnmigratedWorkspaceState } from "../agents/workspace-legacy-state.js";
import { assertConfiguredWorkspaceStateReady } from "../agents/workspace-state-dirs.js";
import { resolveWorkspaceStateIdentity } from "../agents/workspace-state-identity.js";
import {
  deleteWorkspaceState,
  prepareWorkspaceStateDeletion,
} from "../agents/workspace-state-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  detectLegacyWorkspaceState,
  migrateLegacyWorkspaceState,
} from "./state-migrations.workspace-setup.js";
import { useWorkspaceMigrationTestFixture } from "./state-migrations.workspace-setup.test-support.js";

const HASH = "a".repeat(64);
type Context = ReturnType<ReturnType<typeof useWorkspaceMigrationTestFixture>["setup"]>;

async function write(file: string, contents: string) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, contents, "utf8");
}

function database(context: Context) {
  return openOpenClawStateDatabase({ env: context.env }).db;
}

function attestationPathFor(
  context: Context,
  key = resolveWorkspaceStateIdentity(context.workspaceDir).workspaceKey,
) {
  return path.join(context.stateDir, "workspace-attestations", `${key}.attested`);
}

function readSetup(context: Context, columns: string) {
  return database(context)
    .prepare(`SELECT ${columns} FROM workspace_setup_state WHERE workspace_key = ?`)
    .get(resolveWorkspaceStateIdentity(context.workspaceDir).workspaceKey);
}

function assertReady(context: Context) {
  assertNoUnmigratedWorkspaceState({ workspaceDir: context.workspaceDir });
}

function expectRetained(context: Context, source: string) {
  expect(fs.existsSync(source)).toBe(true);
  expect(fs.existsSync(`${source}.doctor-importing`)).toBe(false);
  expect(readSetup(context, "workspace_key")).toBeUndefined();
}

describe("legacy workspace Doctor migration", () => {
  const { detect, migrate, setup } = useWorkspaceMigrationTestFixture();

  function aliasWorkspace(context: ReturnType<typeof setup>, workspaceAlias: string) {
    fs.symlinkSync(
      context.workspaceDir,
      workspaceAlias,
      process.platform === "win32" ? "junction" : "dir",
    );
    return {
      ...context,
      cfg: { agents: { defaults: { workspace: workspaceAlias } } } satisfies OpenClawConfig,
      workspaceDir: workspaceAlias,
    };
  }

  async function writeEmptyReservedAttestation(context: ReturnType<typeof setup>): Promise<string> {
    const attestationPath = attestationPathFor(context);
    await write(attestationPath, "");
    return attestationPath;
  }

  it("isolates receipts when a configured alias is repointed", async () => {
    const context = setup();
    const targetB = path.join(context.homeDir, "workspace-b");
    const workspaceAlias = path.join(context.homeDir, "workspace-link");
    fs.mkdirSync(targetB, { recursive: true });
    const aliasContext = aliasWorkspace(context, workspaceAlias);
    const sourcePath = `${workspaceAlias}.attested`;
    const identityA = resolveWorkspaceStateIdentity(context.workspaceDir);
    await write(sourcePath, "openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\n");
    const attestedAtA = new Date("2026-07-15T11:00:00.000Z");
    await fsp.utimes(sourcePath, attestedAtA, attestedAtA);
    expect((await migrate(aliasContext)).warnings).toEqual([]);

    fs.unlinkSync(workspaceAlias);
    fs.symlinkSync(targetB, workspaceAlias, process.platform === "win32" ? "junction" : "dir");
    await deleteWorkspaceState(prepareWorkspaceStateDeletion(workspaceAlias));
    const identityB = resolveWorkspaceStateIdentity(targetB);
    await write(sourcePath, "openclaw-workspace-attestation:v1\n2026-07-15T12:00:00.000Z\n");
    const attestedAtB = new Date("2026-07-15T12:00:00.000Z");
    await fsp.utimes(sourcePath, attestedAtB, attestedAtB);

    expect((await migrate(aliasContext)).warnings).toEqual([]);
    const db = database(context);
    expect(
      db
        .prepare(
          "SELECT workspace_key, attested_at_ms FROM workspace_setup_state ORDER BY workspace_key",
        )
        .all(),
    ).toEqual(
      [
        {
          workspace_key: identityA.workspaceKey,
          attested_at_ms: attestedAtA.getTime(),
        },
        {
          workspace_key: identityB.workspaceKey,
          attested_at_ms: attestedAtB.getTime(),
        },
      ].toSorted((left, right) => left.workspace_key.localeCompare(right.workspace_key)),
    );
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM migration_sources WHERE source_path = ?")
        .get(sourcePath),
    ).toEqual({ count: 2 });
  });

  it("rejects a configured workspace identity change before claiming a source", async () => {
    const context = setup();
    const targetB = path.join(context.homeDir, "workspace-b");
    const workspaceAlias = path.join(context.homeDir, "workspace-link");
    fs.mkdirSync(targetB, { recursive: true });
    const aliasContext = aliasWorkspace(context, workspaceAlias);
    const identityA = resolveWorkspaceStateIdentity(context.workspaceDir);
    const attestationPath = attestationPathFor(context, identityA.workspaceKey);
    await write(attestationPath, "openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\n");
    const detected = await detect(aliasContext);

    const result = await migrateLegacyWorkspaceState({
      detected,
      env: context.env,
      stateDir: context.stateDir,
      beforeClaim: () => {
        fs.unlinkSync(workspaceAlias);
        fs.symlinkSync(targetB, workspaceAlias, process.platform === "win32" ? "junction" : "dir");
      },
    });

    expect(result.warnings[0]).toContain("configured workspace identity changed");
    expect(fs.existsSync(attestationPath)).toBe(true);
    expect(fs.existsSync(`${attestationPath}.doctor-importing`)).toBe(false);
    const db = database(context);
    for (const table of ["workspace_setup_state", "migration_sources", "workspace_path_aliases"]) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it("imports configured and orphan sources only through explicit Doctor repair", async () => {
    const context = setup();
    const orphanKey = "c".repeat(64);
    const attestationPath = attestationPathFor(context, orphanKey);
    await write(
      attestationPath,
      `openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\ngenerated:TOOLS.md:${HASH}\n`,
    );

    const setupPath = path.join(context.workspaceDir, "openclaw-workspace-state.json");
    await write(setupPath, JSON.stringify({ version: 1 }));
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
    const result = await migrate(context);

    expect(result.warnings).toEqual([]);
    expect(
      database(context)
        .prepare(
          "SELECT filename, sha256 FROM workspace_generated_bootstrap_hashes WHERE workspace_key = ?",
        )
        .get(orphanKey),
    ).toEqual({ filename: "TOOLS.md", sha256: HASH });
    expect(fs.existsSync(attestationPath)).toBe(false);
  });

  it("selects the highest-priority whole attestation across equal-time imports", async () => {
    const context = setup();
    const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
    const currentPath = attestationPathFor(context);
    const siblingPath = `${context.workspaceDir}.attested`;
    const sameMtime = new Date("2026-07-15T11:00:00.000Z");
    await write(
      siblingPath,
      `openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\ngenerated:USER.md:${"b".repeat(64)}\n`,
    );
    await fsp.utimes(siblingPath, sameMtime, sameMtime);
    expect((await migrate(context)).warnings).toEqual([]);

    await write(
      currentPath,
      `openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\ngenerated:AGENTS.md:${HASH}\n`,
    );
    await fsp.utimes(currentPath, sameMtime, sameMtime);
    await write(
      siblingPath,
      `openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\ngenerated:TOOLS.md:${"b".repeat(64)}\n`,
    );
    await fsp.utimes(siblingPath, sameMtime, sameMtime);

    const result = await migrate(context);

    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(currentPath)).toBe(false);
    expect(fs.existsSync(siblingPath)).toBe(false);
    expect(
      database(context)
        .prepare(
          "SELECT filename, sha256 FROM workspace_generated_bootstrap_hashes WHERE workspace_key = ?",
        )
        .all(identity.workspaceKey),
    ).toEqual([{ filename: "AGENTS.md", sha256: HASH }]);
  });

  it("resumes an interrupted unreceipted claim", async () => {
    const context = setup();
    const setupPath = path.join(context.workspaceDir, "openclaw-workspace-state.json");
    const claimPath = `${setupPath}.doctor-importing`;
    await write(setupPath, JSON.stringify({ onboardingCompletedAt: "2026-07-15T10:01:00.000Z" }));
    await fsp.rename(setupPath, claimPath);

    const result = await migrate(context);

    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(claimPath)).toBe(false);
    expect(readSetup(context, "setup_completed_at")).toEqual({
      setup_completed_at: "2026-07-15T10:01:00.000Z",
    });
  });

  it.each(["symlink", "hardlink", "invalid-bootstrap-timestamp", "oversized-attestation"] as const)(
    "rejects %s without changing canonical state",
    async (kind) => {
      const context = setup();
      const setupPath = path.join(context.workspaceDir, "openclaw-workspace-state.json");
      let sourcePath = setupPath;
      if (kind === "oversized-attestation") {
        const attestationPath = attestationPathFor(context);
        sourcePath = attestationPath;
        await write(
          attestationPath,
          `openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\n${"x".repeat(3_000)}`,
        );
      } else {
        const targetPath = path.join(context.workspaceDir, "target.json");
        await write(targetPath, JSON.stringify({ version: 1 }));
        if (kind === "symlink") {
          await fsp.symlink(targetPath, setupPath);
        } else if (kind === "hardlink") {
          await fsp.link(targetPath, setupPath);
        } else if (kind === "invalid-bootstrap-timestamp") {
          await write(
            setupPath,
            JSON.stringify({ version: 1, bootstrapSeededAt: "2026-07-15T10:00:00Z" }),
          );
        }
      }

      const result = await migrate(context);

      expect(result.warnings[0]).toMatch(/legacy workspace/i);
      expect(result.warnings[0]).toContain(sourcePath);
      expect(result.warnings[0]).toContain("Stop the Gateway");
      expect(result.warnings[0]).toContain(".rejected-<timestamp>");
      expect(result.warnings[0]).toContain("openclaw doctor --fix");
      expectRetained(context, sourcePath);
      if (kind === "invalid-bootstrap-timestamp") {
        const original = await fsp.readFile(sourcePath);
        const retainedPath = `${sourcePath}.rejected-2026-07-15T11-00-00`;
        expect(() => assertReady(context)).toThrow(/requires migration/);
        await fsp.rename(sourcePath, retainedPath);
        expect(await fsp.readFile(retainedPath)).toEqual(original);
        expect((await detect(context)).hasLegacy).toBe(false);
        expect(await migrate(context)).toEqual({ changes: [], warnings: [] });
        expect(() => assertReady(context)).not.toThrow();
      }
    },
  );

  it("discards an empty reserved hashed attestation and unblocks the workspace", async () => {
    const context = setup();
    const attestationPath = await writeEmptyReservedAttestation(context);

    expect((await detect(context)).hasLegacy).toBe(true);
    expect(() => assertReady(context)).toThrow(/requires migration/);

    const result = await migrate(context);

    expect(result.warnings).toEqual([]);
    expect(result.changes[0]).toContain(attestationPath);
    expect(fs.existsSync(attestationPath)).toBe(false);
    expect(fs.existsSync(`${attestationPath}.doctor-importing`)).toBe(false);
    expect((await detect(context)).hasLegacy).toBe(false);
    expect(() => assertReady(context)).not.toThrow();
    expect(readSetup(context, "workspace_key")).toBeUndefined();
  });

  it("restores an empty reserved hashed attestation that changes before claim", async () => {
    const context = setup();
    const attestationPath = await writeEmptyReservedAttestation(context);
    const replacementPath = path.join(context.homeDir, "empty-attestation-replacement");
    await write(replacementPath, "");
    const replacementInode = fs.statSync(replacementPath).ino;
    const originalInode = fs.statSync(attestationPath).ino;

    const result = await migrateLegacyWorkspaceState({
      detected: await detect(context),
      env: context.env,
      stateDir: context.stateDir,
      beforeClaim: (source) => {
        if (source.sourcePath === attestationPath) {
          fs.renameSync(replacementPath, attestationPath);
        }
      },
    });

    expect(result.warnings[0]).toContain(attestationPath);
    expect(result.warnings[0]).toMatch(/changed before Doctor could claim/i);
    expect(fs.existsSync(`${attestationPath}.doctor-importing`)).toBe(false);
    expect(fs.existsSync(attestationPath)).toBe(true);
    expect(fs.statSync(attestationPath).ino).toBe(replacementInode);
    expect(fs.statSync(attestationPath).ino).not.toBe(originalInode);
  });

  it("retains an empty workspace-sibling file and does not treat it as reserved state", async () => {
    const context = setup();
    const siblingPath = `${context.workspaceDir}.attested`;
    await write(siblingPath, "");

    expect((await detect(context)).hasLegacy).toBe(false);
    const result = await migrate(context);

    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(siblingPath)).toBe(true);
    expect(() => assertReady(context)).not.toThrow();
  });

  it.each(["setup", "attestation"] as const)(
    "rejects %s beneath a symlinked parent",
    async (kind) => {
      const context = setup();
      const externalDir = path.join(context.homeDir, "external-state");
      const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
      const externalSource = path.join(
        externalDir,
        kind === "setup" ? "workspace-state.json" : `${identity.workspaceKey}.attested`,
      );
      const raw =
        kind === "setup"
          ? JSON.stringify({ version: 1 })
          : "openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\n";
      await write(externalSource, raw);
      await fsp.mkdir(context.stateDir, { recursive: true });
      await fsp.symlink(
        externalDir,
        kind === "setup"
          ? path.join(context.workspaceDir, ".openclaw")
          : path.join(context.stateDir, "workspace-attestations"),
      );
      expect((await detect(context)).hasLegacy).toBe(true);
      const result = await migrate(context);
      expect(result.warnings[0]).toMatch(/legacy workspace/i);
      await expect(fsp.readFile(externalSource, "utf8")).resolves.toBe(raw);
      expect(fs.existsSync(`${externalSource}.doctor-importing`)).toBe(false);
      expect(readSetup(context, "workspace_key")).toBeUndefined();
    },
  );

  it("retains a setup source that changes before Doctor claims it", async () => {
    const context = setup();
    const setupPath = path.join(context.workspaceDir, "openclaw-workspace-state.json");
    await write(setupPath, JSON.stringify({ version: 1 }));

    const result = await migrateLegacyWorkspaceState({
      detected: await detect(context),
      env: context.env,
      stateDir: context.stateDir,
      beforeClaim: () => {
        fs.writeFileSync(
          setupPath,
          JSON.stringify({ version: 1, setupCompletedAt: "2026-07-16T00:00:00.000Z" }),
        );
      },
    });

    expect(result.warnings[0]).toContain("changed before Doctor could claim it");
    expectRetained(context, setupPath);
  });

  it.each(["old", "conflicting"])(
    "uses receipts for idempotent cleanup-only retries (%s receipt)",
    async (kind) => {
      const conflicting = kind === "conflicting";
      const context = setup();
      const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
      const setupPath = path.join(context.workspaceDir, "openclaw-workspace-state.json");
      const seededAt = "2026-07-15T00:00:00.000Z";
      const setupSource = JSON.stringify({ version: 1, bootstrapSeededAt: seededAt });
      const claimPath = `${setupPath}.doctor-importing`;
      const canonicalSeededAt = conflicting ? "2026-07-14T00:00:00.000Z" : seededAt;
      if (conflicting) {
        database(context)
          .prepare(
            "INSERT INTO workspace_setup_state (workspace_key, workspace_path, version, bootstrap_seeded_at, updated_at) VALUES (?, ?, 1, ?, 1)",
          )
          .run(identity.workspaceKey, identity.workspacePath, canonicalSeededAt);
      }
      await write(setupPath, setupSource);
      const first = await migrateLegacyWorkspaceState({
        detected: await detect(context),
        env: context.env,
        stateDir: context.stateDir,
        removeSource: () => {
          throw new Error("simulated unlink failure");
        },
      });
      expect(first.warnings[0]).toContain("legacy cleanup failed");
      expect(first.warnings[0]).toContain(setupPath);
      expect(fs.existsSync(claimPath)).toBe(true);
      await write(claimPath, "{invalid");
      const unreadable = await migrate(context);
      expect(unreadable.warnings[0]).toContain(setupPath);
      expect(unreadable.warnings[0]).toContain("invalid JSON");
      expect(await fsp.readFile(claimPath, "utf8")).toBe("{invalid");

      await write(claimPath, setupSource);
      const receiptDb = database(context);
      const archiveReceipt = receiptDb
        .prepare("SELECT report_json FROM migration_sources WHERE source_path = ?")
        .get(setupPath) as { report_json: string };
      const archivePath = JSON.parse(archiveReceipt.report_json).archivePath as string;
      await expect(fsp.readFile(archivePath, "utf8")).resolves.toBe(setupSource);
      if (kind === "old") {
        const oldReport = JSON.parse(archiveReceipt.report_json);
        delete oldReport.archivePath;
        delete oldReport.differences;
        receiptDb
          .prepare("UPDATE migration_sources SET report_json = ? WHERE source_path = ?")
          .run(JSON.stringify(oldReport), setupPath);
      } else {
        await write(archivePath, "partial backup");
        const corruptBackup = await migrate(context);
        expect(corruptBackup.warnings[0]).toContain("backup differs from the claimed source");
        expect(fs.existsSync(claimPath)).toBe(true);
        await write(archivePath, setupSource);
      }
      const retry = await migrate(context);

      expect(retry.warnings).toEqual([]);
      const db = database(context);
      const finalReceipt = db
        .prepare("SELECT report_json FROM migration_sources WHERE source_path = ?")
        .get(setupPath) as { report_json: string };
      const finalArchive = JSON.parse(finalReceipt.report_json).archivePath as string;
      expect(finalArchive === archivePath).toBe(kind !== "old");
      await expect(fsp.readFile(finalArchive, "utf8")).resolves.toBe(setupSource);
      expect(fs.existsSync(claimPath)).toBe(false);
      expect(
        db
          .prepare("SELECT bootstrap_seeded_at FROM workspace_setup_state WHERE workspace_key = ?")
          .get(identity.workspaceKey),
      ).toEqual({ bootstrap_seeded_at: canonicalSeededAt });
      expect(
        db
          .prepare(
            "SELECT source_sha256, removed_source FROM migration_sources WHERE source_path = ?",
          )
          .get(path.join(identity.workspacePath, "openclaw-workspace-state.json")),
      ).toEqual({
        source_sha256: createHash("sha256").update(setupSource).digest("hex"),
        removed_source: 1,
      });
    },
  );

  it("retains a receipt-covered attestation when only its modification time changed", async () => {
    const context = setup();
    const attestationPath = attestationPathFor(context);
    await write(attestationPath, "openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\n");
    const originalMtime = new Date("2026-07-15T11:01:00.000Z");
    await fsp.utimes(attestationPath, originalMtime, originalMtime);
    const first = await migrateLegacyWorkspaceState({
      detected: await detect(context),
      env: context.env,
      stateDir: context.stateDir,
      removeSource: () => {
        throw new Error("simulated unlink failure");
      },
    });
    expect(first.warnings[0]).toContain("legacy cleanup failed");
    const claimPath = `${attestationPath}.doctor-importing`;
    const changedMtime = new Date("2026-07-15T11:02:00.000Z");
    await fsp.utimes(claimPath, changedMtime, changedMtime);

    const retry = await migrate(context);

    expect(retry.warnings[0]).toContain("retired source now conflicts");
    expect(fs.existsSync(claimPath)).toBe(true);
    expect(readSetup(context, "attested_at_ms")).toEqual({
      attested_at_ms: originalMtime.getTime(),
    });
  });

  it("imports both shared-root markers for an explicit fleet without moving content", async () => {
    const context = setup();
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
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        await fsp.writeFile(filePath, `Retained ${relativePath}\n`);
        const { uid, gid, mode } = await fsp.stat(filePath);
        return { bytes: await fsp.readFile(filePath), uid, gid, mode };
      }),
    );
    const rootPath = path.join(context.workspaceDir, "openclaw-workspace-state.json");
    const nestedPath = path.join(context.workspaceDir, ".openclaw", "workspace-state.json");
    const rootSeededAt = "2026-07-15T10:00:00.000Z";
    const completedAt = "2026-07-15T10:01:00.000Z";
    await write(
      rootPath,
      JSON.stringify({
        version: 1,
        bootstrapSeededAt: rootSeededAt,
        setupCompletedAt: completedAt,
      }),
    );
    await write(
      nestedPath,
      JSON.stringify({ version: 1, bootstrapSeededAt: "2026-07-14T09:00:00.000Z" }),
    );

    expect(effectiveDirs).toEqual(
      ["main", "other"].map((id) => path.join(context.workspaceDir, id)),
    );
    // An unused shared root is a Doctor source, not a runtime admission requirement.
    await expect(
      assertConfiguredWorkspaceStateReady({ cfg, env: context.env }),
    ).resolves.toBeUndefined();
    const result = await migrate({ ...context, cfg });

    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(rootPath)).toBe(false);
    expect(fs.existsSync(nestedPath)).toBe(false);
    expect(readSetup(context, "bootstrap_seeded_at, setup_completed_at")).toEqual({
      bootstrap_seeded_at: rootSeededAt,
      setup_completed_at: completedAt,
    });
    expect(cfg).toEqual(originalConfig);
    for (const [index, relativePath] of corpus.entries()) {
      const filePath = path.join(context.workspaceDir, relativePath);
      const { uid, gid, mode } = await fsp.stat(filePath);
      expect({ bytes: await fsp.readFile(filePath), uid, gid, mode }).toEqual(
        originalCorpus[index],
      );
    }
    expect(await detect({ ...context, cfg })).toEqual({ sources: [], hasLegacy: false });
    expect(await migrate({ ...context, cfg })).toEqual({ changes: [], warnings: [] });
  });
});
