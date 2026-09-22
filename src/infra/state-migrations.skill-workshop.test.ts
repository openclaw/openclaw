import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import {
  inspectLegacySkillWorkshopMigration,
  migrateLegacySkillWorkshopProposals,
} from "../commands/doctor-skill-workshop-sqlite.js";
import { createAppliedLegacyProposal } from "../commands/doctor-skill-workshop-sqlite.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { resolveSkillCollectionBackupRoot } from "../skills/workshop/collection-paths.js";
import { readSkillProposalTargetTreeSha256 } from "../skills/workshop/proposal-bundle.js";
import {
  inspectSkillProposal,
  listSkillProposals,
  proposeCreateSkill,
} from "../skills/workshop/service.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import { readStoredProposal } from "../skills/workshop/store-sqlite-record.js";
import {
  importLegacySkillProposal,
  readSkillProposalRollback,
  updateSkillProposalRecord,
} from "../skills/workshop/store.js";
import {
  SKILL_WORKSHOP_ROLLBACK_SCHEMA,
  type SkillProposalRollback,
} from "../skills/workshop/types.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { autoMigrateLegacyState } from "./state-migrations.doctor.js";
import { throwIfDoctorStateMigrationRefused } from "./state-migrations.messages.js";

describe("automatic Skill Workshop migration", () => {
  let state: OpenClawTestState;

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "workshop-startup-migration" });
  });

  afterEach(async () => {
    await state.cleanup();
  });

  async function seedSidecar(name: string, workspaceDir: string) {
    const content = "---\nname: procedure\ndescription: Saved procedure\n---\n\n# Procedure\n";
    const record = {
      ...createAppliedLegacyProposal({
        id: `${name}-20260901-1234567890`,
        title: name,
        description: "Saved procedure",
        content,
        target: { skillKey: name, skillDir: path.join(workspaceDir, "skills", name) },
      }),
      status: "pending" as const,
      appliedAt: undefined,
    };
    const relativeDir = `skill-workshop/proposals/${record.id}`;
    const metadata = JSON.stringify(record);
    const file = await state.writeText(`${relativeDir}/proposal.json`, metadata);
    await state.writeText(`${relativeDir}/PROPOSAL.md`, content);
    return { record, file, metadata };
  }

  it.each([
    { scenario: "moved workspace", mainMatches: 3, opsMatches: 0, missingWorkspace: false },
    { scenario: "missing workspace", mainMatches: 3, opsMatches: 0, missingWorkspace: true },
    { scenario: "ambiguous owner", mainMatches: 3, opsMatches: 3, missingWorkspace: false },
    { scenario: "partial match", mainMatches: 2, opsMatches: 0, missingWorkspace: false },
    { scenario: "changed content", mainMatches: 0, opsMatches: 0, missingWorkspace: false },
  ])(
    "resolves a legacy collection backup by complete relocated content: $scenario",
    async ({ scenario, mainMatches, opsMatches, missingWorkspace }) => {
      const oldWorkspace = state.path("old-workspace");
      const currentWorkspace = missingWorkspace
        ? state.workspaceDir
        : path.join(oldWorkspace, "main");
      const config: OpenClawConfig = {
        agents: {
          entries: {
            main: { workspace: currentWorkspace },
            ops: { workspace: state.path("ops-workspace"), agentDir: state.path("ops-agent") },
          },
        },
      };
      await fs.mkdir(currentWorkspace, { recursive: true });
      await state.writeConfig(config);
      const backupId = "legacy-moved-backup";
      const backupRoot = state.statePath("skill-workshop/collection-backups/0000000000000000");
      const backupDir = path.join(backupRoot, backupId);
      const resultSkillHashes: Record<string, string> = {};
      for (let index = 0; index < 3; index += 1) {
        const name = `procedure-${index}`;
        const relativeDir = path.join("skills", name);
        const content = `---\nname: ${name}\ndescription: Saved procedure\n---\n\n# After cleanup\n`;
        const savedDir = path.join(backupDir, "workspace", relativeDir);
        await fs.mkdir(savedDir, { recursive: true });
        await fs.writeFile(path.join(savedDir, "SKILL.md"), content);
        resultSkillHashes[relativeDir] = await readSkillProposalTargetTreeSha256(savedDir);
        await fs.writeFile(
          path.join(savedDir, "SKILL.md"),
          content.replace("After cleanup", "Before cleanup"),
        );
        for (const [agentId, matches] of [
          ["main", mainMatches],
          ["ops", opsMatches],
        ] as const) {
          const target = path.join(resolveWorkshopSkillsDir(config, agentId, state.env), name);
          await fs.mkdir(target, { recursive: true });
          await fs.writeFile(
            path.join(target, "SKILL.md"),
            index < matches ? content : `${content}\nChanged since cleanup.\n`,
          );
        }
      }
      const manifestPath = path.join(backupDir, "manifest.json");
      const manifest = JSON.stringify({
        schema: "openclaw.skill-collection-backup.v1",
        id: backupId,
        createdAt: "2026-09-01T00:00:00.000Z",
        workspaceDir: oldWorkspace,
        skillDirs: Object.keys(resultSkillHashes),
        resultSkillDirs: Object.keys(resultSkillHashes),
        resultSkillHashes,
      });
      await fs.writeFile(manifestPath, manifest);
      const uniqueOwner = mainMatches === 3 && opsMatches === 0;
      const filesBefore = (await fs.readdir(state.stateDir, { recursive: true })).toSorted();
      await expect(
        inspectLegacySkillWorkshopMigration({ config, env: state.env }),
      ).resolves.toMatchObject({
        legacyBackupRootCount: 1,
      });
      expect((await fs.readdir(state.stateDir, { recursive: true })).toSorted()).toEqual(
        filesBefore,
      );

      for (let attempt = 0; attempt < 2; attempt += 1) {
        // Keep Doctor success/warning integration; matching variants need only the
        // real Workshop owner, with the same files, isolation, and repeat attempt.
        const result =
          scenario === "moved workspace" || scenario === "ambiguous owner"
            ? await autoMigrateLegacyState({
                cfg: config,
                env: state.env,
                homedir: () => state.home,
                doctorOnlyStateMigrations: true,
                legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
              })
            : await migrateLegacySkillWorkshopProposals({
                config,
                env: state.env,
                retireMissingDrafts: true,
              });
        const receipt =
          "stepReceipts" in result
            ? result.stepReceipts.find((entry) => entry.id === "skill-workshop")
            : undefined;
        if ("stepReceipts" in result) {
          expect(receipt).toMatchObject({
            outcome: uniqueOwner ? (attempt === 0 ? "completed" : "skipped") : "warning",
          });
        } else if (uniqueOwner) {
          expect(result.changes.length > 0).toBe(attempt === 0);
        } else {
          expect(result).toMatchObject({ changes: [], warningDisposition: "recoverable" });
        }
        const warnings = receipt?.warnings ?? result.warnings;
        if (uniqueOwner) {
          expect(warnings).toEqual([]);
          await expect(fs.access(backupRoot)).rejects.toMatchObject({ code: "ENOENT" });
          const destination = path.join(
            resolveSkillCollectionBackupRoot(config, "main", state.env),
            backupId,
          );
          await expect(
            fs.readFile(path.join(destination, "skills/procedure-0/SKILL.md"), "utf8"),
          ).resolves.toContain("Before cleanup");
          const converted: unknown = JSON.parse(
            await fs.readFile(path.join(destination, "manifest.json"), "utf8"),
          );
          expect(converted).toMatchObject({ schema: "openclaw.skill-collection-backup.v2" });
          expect(converted).not.toHaveProperty("restoreUnavailableReason");
        } else {
          const warning = warnings.join("\n");
          expect(warning).toContain(`agent main: ${mainMatches}/3 skills match`);
          expect(warning).toContain(`agent ops: ${opsMatches}/3 skills match`);
          expect(warning).toContain(
            opsMatches === 3 ? "candidate agents: main, ops" : "candidate agents: none",
          );
          expect(warning).toContain(
            "https://docs.openclaw.ai/tools/skill-workshop/collection-review#when-an-older-backup-cannot-be-restored-automatically",
          );
          await expect(fs.readFile(manifestPath, "utf8")).resolves.toBe(manifest);
        }
      }
    },
  );

  it.each(
    (["sqlite", "sqlite-no-rollback", "sidecar", "backup"] as const).flatMap((source) =>
      (["valid", "missing", "invalid"] as const).map((setupKind) => ({ source, setupKind })),
    ),
  )(
    "settles $setupKind historical workspace setup referenced by a retained $source before Workshop migration",
    async ({ source, setupKind }) => {
      const historicalWorkspace = state.path("historical-cafe\u0301");
      const currentWorkspace = path.join(historicalWorkspace, "current");
      const config: OpenClawConfig = {
        agents: { defaults: { workspace: currentWorkspace }, entries: { main: {} } },
      };
      await fs.mkdir(currentWorkspace, { recursive: true });
      await state.writeConfig(config);
      const setup = {
        bootstrapSeededAt: "2026-09-01T10:00:00.000Z",
        setupCompletedAt: "2026-09-01T10:01:00.000Z",
      };
      const setupPath = path.join(historicalWorkspace, "openclaw-workspace-state.json");
      const setupText = JSON.stringify({ version: 1, ...setup });
      if (setupKind !== "missing") {
        await fs.writeFile(setupPath, setupKind === "valid" ? setupText : "{invalid");
      }
      const proposal = await seedSidecar("historical", historicalWorkspace);
      const ownedRecord = { ...proposal.record, origin: { agentId: "main" } };
      if (source === "sidecar") {
        await fs.writeFile(proposal.file, JSON.stringify(ownedRecord));
      } else {
        await fs.unlink(proposal.file);
        if (source === "sqlite" || source === "sqlite-no-rollback") {
          importLegacySkillProposal({
            record: ownedRecord,
            ownerAgentId: "main",
            store: { env: state.env },
          });
          if (source === "sqlite-no-rollback") {
            openOpenClawStateDatabase({ env: state.env }).db.exec(
              "DROP TABLE skill_workshop_proposal_rollbacks",
            );
            closeOpenClawStateDatabaseForTest();
          }
        } else {
          await state.writeText(
            "skill-workshop/collection-backups/0000000000000000/legacy-backup/manifest.json",
            JSON.stringify({
              schema: "openclaw.skill-collection-backup.v1",
              id: "legacy-backup",
              createdAt: "2026-09-01T00:00:00.000Z",
              workspaceDir: historicalWorkspace,
              skillDirs: [],
              resultSkillDirs: [],
              resultSkillHashes: {},
            }),
          );
        }
      }

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await autoMigrateLegacyState({
          cfg: config,
          env: state.env,
          homedir: () => state.home,
          doctorOnlyStateMigrations: true,
          legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        });
        expect(
          () => throwIfDoctorStateMigrationRefused(result.stepReceipts),
          result.warnings.join("\n"),
        ).not.toThrow();
        if (setupKind === "valid") {
          await expect(
            readWorkspaceStateSnapshot(historicalWorkspace, { env: state.env }),
          ).resolves.toMatchObject({ setup });
        } else if (attempt === 0) {
          expect(result.warnings.join("\n")).toContain(historicalWorkspace);
        }
        if (source === "backup") {
          expect(result.warnings.join("\n")).toContain("candidate agents: none");
        } else {
          await expect(
            inspectSkillProposal(proposal.record.id, { config, agentId: "main", env: state.env }),
          ).resolves.toMatchObject({
            record:
              setupKind === "valid"
                ? { status: "pending", target: { source: "openclaw-workshop" } }
                : { status: "stale", statusReason: expect.stringContaining(historicalWorkspace) },
          });
        }
      }
      if (setupKind === "invalid") {
        await expect(fs.readFile(setupPath, "utf8")).resolves.toBe("{invalid");
      } else {
        await expect(fs.access(setupPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
      if (setupKind === "valid") {
        const archives = (await fs.readdir(historicalWorkspace)).filter((name) =>
          name.startsWith("openclaw-workspace-state.json.migrated."),
        );
        expect(archives).toHaveLength(1);
        await expect(
          fs.readFile(path.join(historicalWorkspace, archives[0]!), "utf8"),
        ).resolves.toBe(setupText);
        expect(
          openOpenClawStateDatabase({ env: state.env })
            .db.prepare("SELECT removed_source FROM migration_sources WHERE source_path = ?")
            .get(setupPath),
        ).toEqual({ removed_source: 1 });
      }
      expect(config.agents?.defaults?.workspace).toBe(currentWorkspace);
    },
  );

  it.each(["valid", "malformed", "connected"] as const)(
    "preserves %s unfinished apply recovery at an unusable historical workspace",
    async (recoveryKind) => {
      const historicalWorkspace = state.workspaceDir;
      const config = {
        agents: {
          defaults: { workspace: path.join(historicalWorkspace, "current") },
          entries: { main: {} },
        },
      };
      await state.writeConfig(config);
      const proposal = await seedSidecar("unfinished", historicalWorkspace);
      await fs.unlink(proposal.file);
      await fs.writeFile(
        path.join(historicalWorkspace, "openclaw-workspace-state.json"),
        "{invalid",
      );
      const rollback: SkillProposalRollback = {
        schema: SKILL_WORKSHOP_ROLLBACK_SCHEMA,
        proposalId: proposal.record.id,
        writtenAt: "2026-09-01T00:00:00.000Z",
        targetSkillFile: proposal.record.target.skillFile,
        action: "create",
        supportFiles: [],
      };
      importLegacySkillProposal({
        record: proposal.record,
        rollback,
        ownerAgentId: "main",
        store: { env: state.env },
      });
      const database = openOpenClawStateDatabase({ env: state.env }).db;
      if (recoveryKind === "malformed") {
        database
          .prepare(
            "UPDATE skill_workshop_proposal_rollbacks SET support_files_json = ? WHERE proposal_id = ?",
          )
          .run("{}", proposal.record.id);
      }
      const rollbackBefore = database
        .prepare("SELECT * FROM skill_workshop_proposal_rollbacks WHERE proposal_id = ?")
        .get(proposal.record.id);
      const connectedContent =
        "---\nname: unfinished\ndescription: Connected procedure\n---\n\n# Procedure\n";
      const connected = createAppliedLegacyProposal({
        id: "connected-20260901-1234567890",
        title: "Connected",
        description: "Connected proposal",
        content: connectedContent,
        target: {
          skillKey: "unfinished",
          skillDir: path.join(config.agents.defaults.workspace, "skills", "unfinished"),
        },
      });
      if (recoveryKind === "connected") {
        await fs.mkdir(connected.target.skillDir, { recursive: true });
        await fs.writeFile(connected.target.skillFile, connectedContent);
        importLegacySkillProposal({
          record: connected,
          ownerAgentId: "main",
          store: { env: state.env },
        });
      }
      const before = readStoredProposal(proposal.record.id, { env: state.env });
      const result = await autoMigrateLegacyState({
        cfg: config,
        env: state.env,
        homedir: () => state.home,
        doctorOnlyStateMigrations: true,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
      expect(() => throwIfDoctorStateMigrationRefused(result.stepReceipts)).not.toThrow();
      expect(readStoredProposal(proposal.record.id, { env: state.env })).toEqual(before);
      expect(result.warnings.join("\n")).toContain("unfinished apply recovery");
      expect(
        openOpenClawStateDatabase({ env: state.env })
          .db.prepare("SELECT * FROM skill_workshop_proposal_rollbacks WHERE proposal_id = ?")
          .get(proposal.record.id),
      ).toEqual(rollbackBefore);
      if (recoveryKind !== "malformed") {
        await expect(
          readSkillProposalRollback(proposal.record.id, { env: state.env }),
        ).resolves.toEqual(rollback);
      }
      if (recoveryKind === "connected") {
        expect(readStoredProposal(connected.id, { env: state.env })?.record).toEqual(connected);
        await expect(fs.access(connected.target.skillFile)).resolves.toBeUndefined();
      }
    },
  );

  it.each([
    { item: "proposal", candidates: ["alpha", "beta"] },
    { item: "proposal", candidates: [] },
    { item: "backup", candidates: ["alpha", "beta"] },
    { item: "backup", candidates: [] },
  ])(
    "continues Doctor with $item ownership candidates $candidates",
    async ({ item, candidates }) => {
      const ambiguousWorkspace = state.path("unresolved-workspace");
      const config: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: {
            main: { workspace: state.workspaceDir },
            ...Object.fromEntries(candidates.map((id) => [id, { workspace: ambiguousWorkspace }])),
          },
        },
      };
      await state.writeConfig(config);
      const eligible = await seedSidecar("eligible", state.workspaceDir);
      const preserved =
        item === "proposal"
          ? await seedSidecar("unresolved", ambiguousWorkspace)
          : await (async () => {
              const metadata = JSON.stringify({
                schema: "openclaw.skill-collection-backup.v1",
                id: "legacy-backup",
                createdAt: "2026-09-01T00:00:00.000Z",
                workspaceDir: ambiguousWorkspace,
                skillDirs: [],
                resultSkillDirs: [],
                resultSkillHashes: {},
              });
              const file = await state.writeText(
                "skill-workshop/collection-backups/0000000000000000/legacy-backup/manifest.json",
                metadata,
              );
              return { file, metadata };
            })();

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await autoMigrateLegacyState({
          cfg: config,
          env: state.env,
          homedir: () => state.home,
          doctorOnlyStateMigrations: true,
          legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        });
        const workshop = result.stepReceipts.find((receipt) => receipt.id === "skill-workshop");
        expect(workshop).toMatchObject({ outcome: "warning" });
        expect(() => throwIfDoctorStateMigrationRefused(result.stepReceipts)).not.toThrow();
        const warning = workshop?.warnings.join("\n");
        expect(warning).toContain(
          item === "proposal"
            ? path.dirname(preserved.file)
            : path.dirname(path.dirname(preserved.file)),
        );
        expect(warning).toContain(`candidate agents: ${candidates.join(", ") || "none"}`);
        await expect(fs.readFile(preserved.file, "utf8")).resolves.toBe(preserved.metadata);
        await expect(
          inspectLegacySkillWorkshopMigration({ config, env: state.env }),
        ).resolves.toMatchObject({
          externalProposalCount: 0,
        });
      }
      await expect(fs.access(eligible.file)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        inspectSkillProposal(eligible.record.id, { config, agentId: "main", env: state.env }),
      ).resolves.toMatchObject({
        record: { status: "pending", target: { source: "openclaw-workshop" } },
      });
    },
  );

  it("discovers unreadable backup roots before importing sidecars", async () => {
    const config = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
    const eligible = await seedSidecar("eligible", state.workspaceDir);
    await state.writeText("skill-workshop/collection-backups", "not a directory");

    await expect(
      migrateLegacySkillWorkshopProposals({ config, env: state.env }),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(fs.readFile(eligible.file, "utf8")).resolves.toBe(eligible.metadata);
  });

  it("keeps a corrupt proposal fatal alongside recoverable ownership warnings", async () => {
    const config = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
    await state.writeConfig(config);
    await seedSidecar("unresolved", state.path("unconfigured-workspace"));
    const corrupt = await seedSidecar("corrupt", state.workspaceDir);
    await fs.writeFile(path.join(path.dirname(corrupt.file), "PROPOSAL.md"), "corrupt draft");

    const result = await autoMigrateLegacyState({
      cfg: config,
      env: state.env,
      homedir: () => state.home,
      doctorOnlyStateMigrations: true,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });
    expect(result.stepReceipts.find((receipt) => receipt.id === "skill-workshop")).toMatchObject({
      outcome: "refused",
      warnings: [
        expect.stringContaining("draft hash does not match"),
        expect.stringContaining("owning agent could not be inferred"),
      ],
    });
    expect(() => throwIfDoctorStateMigrationRefused(result.stepReceipts)).toThrow("Doctor stopped");
    await expect(fs.readFile(corrupt.file, "utf8")).resolves.toBe(corrupt.metadata);
  });

  it.each([
    "corrupt draft",
    "interrupted apply",
    "corrupt rollback",
    "missing draft with rollback",
  ] as const)(
    "refuses an ownerless bundle with %s before deferring ownership",
    async (artifact) => {
      const config = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
      await state.writeConfig(config);
      const proposal = await seedSidecar("ownerless", state.path("unconfigured-workspace"));
      const proposalDir = path.dirname(proposal.file);
      const draftPath = path.join(proposalDir, "PROPOSAL.md");
      const rollbackPath = path.join(proposalDir, "rollback.json");
      const rollback: SkillProposalRollback = {
        schema: SKILL_WORKSHOP_ROLLBACK_SCHEMA,
        proposalId: proposal.record.id,
        writtenAt: "2026-09-01T00:00:00.000Z",
        targetSkillFile: proposal.record.target.skillFile,
        action: "create",
        supportFiles: [],
      };
      const rollbackText = artifact === "corrupt rollback" ? "{broken" : JSON.stringify(rollback);
      const missingDraft = artifact === "missing draft with rollback";
      if (artifact === "corrupt draft") {
        await fs.writeFile(draftPath, "corrupt draft");
      } else {
        await fs.writeFile(rollbackPath, rollbackText);
        if (missingDraft) {
          await fs.unlink(draftPath);
        }
      }
      const draft = missingDraft ? undefined : await fs.readFile(draftPath, "utf8");

      const result = await autoMigrateLegacyState({
        cfg: config,
        env: state.env,
        homedir: () => state.home,
        doctorOnlyStateMigrations: true,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
      const receipt = result.stepReceipts.find((entry) => entry.id === "skill-workshop");
      expect(receipt).toMatchObject({
        outcome: "refused",
        warnings: [
          expect.stringContaining(
            `Failed to migrate Skill Workshop proposal ${proposal.record.id}`,
          ),
        ],
      });
      if (artifact === "corrupt draft") {
        expect(receipt?.warnings.join("\n")).toContain("draft hash does not match");
      } else if (artifact === "interrupted apply" || missingDraft) {
        expect(receipt?.warnings.join("\n")).toContain("unfinished apply recovery");
      }
      expect(() => throwIfDoctorStateMigrationRefused(result.stepReceipts)).toThrow(
        "Doctor stopped",
      );
      await expect(fs.readFile(proposal.file, "utf8")).resolves.toBe(proposal.metadata);
      if (missingDraft) {
        await expect(fs.access(draftPath)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(fs.readFile(draftPath, "utf8")).resolves.toBe(draft);
      }
      if (artifact !== "corrupt draft") {
        await expect(fs.readFile(rollbackPath, "utf8")).resolves.toBe(rollbackText);
      }
    },
  );

  it.each([15, 16])(
    "keeps pending proposals readable after migrating legacy targets from schema %i",
    async (schemaVersion) => {
      const agentDir = state.path("custom-agent");
      const config: OpenClawConfig = {
        agents: {
          entries: {
            main: { default: true, workspace: state.workspaceDir, agentDir },
          },
        },
      };
      await state.writeConfig(config);
      const proposal = await proposeCreateSkill({
        config,
        agentId: "main",
        workspaceDir: state.workspaceDir,
        env: state.env,
        name: "upgrade-procedure",
        description: "Keep a pending procedure across upgrades",
        content: "# Procedure\n\nVerify the saved proposal after upgrading.\n",
      });
      const legacySkillDir = path.join(state.workspaceDir, "skills", "upgrade-procedure");
      await updateSkillProposalRecord({
        record: {
          ...proposal.record,
          target: {
            ...proposal.record.target,
            skillDir: legacySkillDir,
            skillFile: path.join(legacySkillDir, "SKILL.md"),
            source: "openclaw-workspace",
          },
        },
        store: { config, agentId: "main", env: state.env },
      });
      const databasePath = openOpenClawStateDatabase({ env: state.env }).path;
      closeOpenClawStateDatabaseForTest();
      if (schemaVersion === 15) {
        const legacy = openNodeSqliteDatabase(databasePath);
        try {
          legacy.exec(`
            ALTER TABLE skill_workshop_proposals ADD COLUMN workspace_dir TEXT NOT NULL DEFAULT '';
            ALTER TABLE skill_workshop_proposals ADD COLUMN claim_released_time INTEGER;
            DROP TABLE skill_workshop_collection_reviews;
            CREATE TABLE skill_workshop_collection_reviews (
              review_id TEXT NOT NULL PRIMARY KEY,
              workspace_dir TEXT NOT NULL,
              backup_id TEXT NOT NULL,
              create_time INTEGER NOT NULL,
              kept_names_json TEXT NOT NULL,
              written_names_json TEXT NOT NULL,
              dropped_json TEXT NOT NULL
            ) STRICT;
            PRAGMA user_version = 15;
            UPDATE schema_meta SET schema_version = 15 WHERE meta_key = 'primary';
          `);
          legacy
            .prepare("UPDATE skill_workshop_proposals SET workspace_dir = ?")
            .run(state.workspaceDir);
        } finally {
          legacy.close();
        }
      }

      const migration = await autoMigrateLegacyState({
        cfg: config,
        env: state.env,
        homedir: () => state.home,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
      expect(migration.warnings).toEqual([]);
      const scope = { config, agentId: "main", env: state.env };
      const listed = await listSkillProposals(scope);
      expect(listed.proposals).toEqual([
        expect.objectContaining({ id: proposal.record.id, status: "pending" }),
      ]);
      const skillDir = path.join(agentDir, "workshop-skills", "upgrade-procedure");
      await expect(inspectSkillProposal(proposal.record.id, scope)).resolves.toMatchObject({
        content: proposal.content,
        record: {
          id: proposal.record.id,
          status: "pending",
          target: {
            skillDir,
            skillFile: path.join(skillDir, "SKILL.md"),
            source: "openclaw-workshop",
          },
        },
      });
    },
  );
});
