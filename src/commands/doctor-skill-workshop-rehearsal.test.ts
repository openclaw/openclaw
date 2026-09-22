import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readWorkspaceStateSnapshot,
  replaceWorkspaceAttestation,
  WORKSPACE_CONTENT_RELOCATION_MIGRATION_KIND,
} from "../agents/workspace-state-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { resolveSkillCollectionBackupRoot } from "../skills/workshop/collection-paths.js";
import {
  renderProposalMarkdown,
  stripProposalFrontmatterForSkill,
} from "../skills/workshop/frontmatter.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import { hashSkillProposalContent, importLegacySkillProposal } from "../skills/workshop/store.js";
import {
  SKILL_WORKSHOP_ROLLBACK_SCHEMA,
  type SkillProposalRecord,
  type SkillProposalRollback,
} from "../skills/workshop/types.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  inspectLegacySkillWorkshopMigration,
  migrateLegacySkillWorkshopProposals,
} from "./doctor-skill-workshop-sqlite.js";
import { createAppliedLegacyProposal } from "./doctor-skill-workshop-sqlite.test-support.js";
import { prepareWorkshopWorkspaceRelocation } from "./doctor-skill-workshop-workspaces.js";

function rehearsalEnv(state: OpenClawTestState): NodeJS.ProcessEnv {
  return {
    ...state.env,
    ...buildUpdateRehearsalPathEnv(state.stateDir),
    OPENCLAW_UPDATE_IN_PROGRESS: "1",
    OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
    OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
  };
}

function configForWorkspace(workspaceDir: string): OpenClawConfig {
  return { agents: { entries: { main: { workspace: workspaceDir } } } };
}

async function fileHashes(directory: string): Promise<Record<string, string>> {
  const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true });
  return Object.fromEntries(
    await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const filePath = path.join(entry.parentPath, entry.name);
          return [
            path.relative(directory, filePath),
            createHash("sha256")
              .update(await fs.readFile(filePath))
              .digest("hex"),
          ];
        }),
    ),
  );
}

function legacyProposal(workspaceDir: string) {
  const name = "rehearsal-procedure";
  const draft = renderProposalMarkdown({
    name,
    description: "Verify the migration result",
    content: "# Procedure\n\nVerify the saved result.\n",
    date: "2026-09-01T00:00:00.000Z",
  });
  const record: SkillProposalRecord = {
    ...createAppliedLegacyProposal({
      id: "rehearsal-procedure-20260901-1234567890",
      title: "Create rehearsal procedure",
      description: "Verify the migration result",
      content: draft,
      target: { skillKey: name, skillDir: path.join(workspaceDir, "skills", name) },
    }),
    origin: { agentId: "main" },
  };
  return { record, draft, content: stripProposalFrontmatterForSkill(draft) };
}

describe("Workshop migration in an update rehearsal", () => {
  it.each(["partial", "complete"] as const)(
    "preserves external files and pending rollback state after a %s apply",
    async (applyState) => {
      await withOpenClawTestState({ label: "workshop-rehearsal-rollback" }, async (state) => {
        const env = rehearsalEnv(state);
        const config = configForWorkspace(state.workspaceDir);
        const legacy = legacyProposal(state.workspaceDir);
        const supportPath = "references/verification.md";
        const supportContent = "Retain the recorded verification steps.\n";
        const pending: SkillProposalRecord = {
          ...legacy.record,
          status: "pending",
          appliedAt: undefined,
          supportFiles: [
            {
              path: supportPath,
              sizeBytes: Buffer.byteLength(supportContent),
              hash: hashSkillProposalContent(supportContent),
            },
          ],
        };
        const rollback: SkillProposalRollback = {
          schema: SKILL_WORKSHOP_ROLLBACK_SCHEMA,
          proposalId: pending.id,
          writtenAt: pending.createdAt,
          targetSkillFile: pending.target.skillFile,
          action: "create",
          supportFiles: [{ path: supportPath, existed: false }],
        };
        const supportFile = path.join(pending.target.skillDir, supportPath);
        await fs.mkdir(path.dirname(supportFile), { recursive: true });
        await fs.writeFile(supportFile, supportContent);
        if (applyState === "complete") {
          await fs.writeFile(pending.target.skillFile, legacy.content);
        }
        await state.writeText(`skill-workshop/proposals/${pending.id}/PROPOSAL.md`, legacy.draft);
        await state.writeText(
          `skill-workshop/proposals/${pending.id}/${supportPath}`,
          supportContent,
        );
        importLegacySkillProposal({
          record: pending,
          rollback,
          ownerAgentId: "main",
          store: { env: state.env },
        });
        const db = openOpenClawStateDatabase({ env: state.env }).db;
        const proposalRows = () =>
          db
            .prepare("SELECT * FROM skill_workshop_proposals WHERE proposal_id = ?")
            .all(pending.id);
        const rollbackRows = () =>
          db
            .prepare("SELECT * FROM skill_workshop_proposal_rollbacks WHERE proposal_id = ?")
            .all(pending.id);
        const before = {
          files: await fileHashes(state.workspaceDir),
          proposals: proposalRows(),
          rollbacks: rollbackRows(),
        };
        expect(before.rollbacks).toHaveLength(1);

        const result = await migrateLegacySkillWorkshopProposals({
          config,
          env,
          retireMissingDrafts: true,
        });

        expect(result.warnings).toEqual([]);
        expect(await fileHashes(state.workspaceDir)).toEqual(before.files);
        expect(proposalRows()).toEqual(before.proposals);
        expect(rollbackRows()).toEqual(before.rollbacks);
        await expect(
          fs.access(
            path.join(resolveWorkshopSkillsDir(config, "main", env), pending.target.skillKey),
          ),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(inspectLegacySkillWorkshopMigration({ config, env })).resolves.toMatchObject({
          externalProposalCount: 0,
        });
      });
    },
  );

  it.each(["external", "owned"] as const)(
    "keeps external sidecars as inventory while migrating owned copies: %s",
    async (location) => {
      await withOpenClawTestState({ label: "workshop-rehearsal-sidecars" }, async (state) => {
        const env = rehearsalEnv(state);
        const workspaceDir =
          location === "external" ? state.workspaceDir : path.join(state.stateDir, "workspace");
        const config = configForWorkspace(workspaceDir);
        const { record, draft, content } = legacyProposal(workspaceDir);
        await fs.mkdir(record.target.skillDir, { recursive: true });
        await fs.writeFile(record.target.skillFile, content);
        const proposalDir = path.join(state.stateDir, "skill-workshop", "proposals", record.id);
        await state.writeText(`skill-workshop/proposals/${record.id}/PROPOSAL.md`, draft);
        await state.writeJson(`skill-workshop/proposals/${record.id}/proposal.json`, record);
        const index = await state.writeJson("skill-workshop/proposals.json", {
          proposals: [record.id],
        });
        const before = {
          source: await fileHashes(workspaceDir),
          sidecars: await fileHashes(proposalDir),
          index: await fs.readFile(index, "utf8"),
        };
        const db = openOpenClawStateDatabase({ env: state.env }).db;

        const result = await migrateLegacySkillWorkshopProposals({ config, env });

        expect(result.warnings).toEqual([]);
        const rows = db
          .prepare(`
            SELECT json_extract(record_json, '$.target.source') AS source,
              json_extract(record_json, '$.target.skillDir') AS skill_dir,
              json_extract(record_json, '$.target.skillFile') AS skill_file
            FROM skill_workshop_proposals WHERE proposal_id = ?
          `)
          .all(record.id);
        if (location === "external") {
          expect(result.migrated).toBe(0);
          expect(await fileHashes(workspaceDir)).toEqual(before.source);
          expect(await fileHashes(proposalDir)).toEqual(before.sidecars);
          expect(await fs.readFile(index, "utf8")).toBe(before.index);
          expect(rows).toEqual([]);
        } else {
          expect(result.migrated).toBe(1);
          expect(rows).toHaveLength(1);
          const destination = path.join(
            resolveWorkshopSkillsDir(config, "main", env),
            record.target.skillKey,
          );
          await expect(fs.readFile(path.join(destination, "SKILL.md"), "utf8")).resolves.toBe(
            content,
          );
          await expect(fs.access(record.target.skillDir)).rejects.toMatchObject({ code: "ENOENT" });
          await expect(fs.access(path.join(proposalDir, "proposal.json"))).rejects.toMatchObject({
            code: "ENOENT",
          });
          await expect(fs.access(index)).rejects.toMatchObject({ code: "ENOENT" });
          expect(rows).toEqual([
            {
              source: "openclaw-workshop",
              skill_dir: destination,
              skill_file: path.join(destination, "SKILL.md"),
            },
          ]);
        }
      });
    },
  );

  it("preserves an external collection backup batch without publishing rewritten archives", async () => {
    await withOpenClawTestState({ label: "workshop-rehearsal-backups" }, async (state) => {
      const env = rehearsalEnv(state);
      const config = configForWorkspace(state.workspaceDir);
      const relativeSkillDir = path.join("skills", "rehearsal-procedure");
      const legacyRoot = path.join(
        state.stateDir,
        "skill-workshop",
        "collection-backups",
        "0000000000000000",
      );
      await fs.mkdir(path.join(state.workspaceDir, relativeSkillDir), { recursive: true });
      await fs.writeFile(
        path.join(state.workspaceDir, relativeSkillDir, "SKILL.md"),
        "Current operator skill.\n",
      );
      for (const id of ["2026-09-01T00-00-00.000Z-first", "2026-09-02T00-00-00.000Z-second"]) {
        const backupDir = path.join(legacyRoot, id);
        await fs.mkdir(path.join(backupDir, "workspace", relativeSkillDir), { recursive: true });
        await fs.writeFile(
          path.join(backupDir, "workspace", relativeSkillDir, "SKILL.md"),
          `Saved skill ${id}.\n`,
        );
        await fs.writeFile(
          path.join(backupDir, "manifest.json"),
          JSON.stringify({
            schema: "openclaw.skill-collection-backup.v1",
            id,
            createdAt: "2026-09-01T00:00:00.000Z",
            workspaceDir: state.workspaceDir,
            skillDirs: [relativeSkillDir],
            resultSkillDirs: [],
            resultSkillHashes: {},
          }),
        );
      }
      const before = {
        backups: await fileHashes(legacyRoot),
        source: await fileHashes(state.workspaceDir),
      };

      const result = await migrateLegacySkillWorkshopProposals({ config, env });

      expect(result.warnings).toEqual([]);
      expect(await fileHashes(legacyRoot)).toEqual(before.backups);
      expect(await fileHashes(state.workspaceDir)).toEqual(before.source);
      await expect(
        fs.access(resolveSkillCollectionBackupRoot(config, "main", env)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(inspectLegacySkillWorkshopMigration({ config, env })).resolves.toMatchObject({
        legacyBackupRootCount: 0,
      });
    });
  });

  it("does not replay a prepared relocation receipt for an external workspace", async () => {
    await withOpenClawTestState({ label: "workshop-rehearsal-receipt" }, async (state) => {
      const env = rehearsalEnv(state);
      const config = configForWorkspace(state.workspaceDir);
      const { record, content } = legacyProposal(state.workspaceDir);
      await fs.mkdir(record.target.skillDir, { recursive: true });
      await fs.writeFile(record.target.skillFile, content);
      await replaceWorkspaceAttestation({
        workspaceDir: state.workspaceDir,
        attestedAtMs: Date.now(),
        generatedHashes: new Map(),
      });
      const destination = path.join(
        resolveWorkshopSkillsDir(config, "main", state.env),
        record.target.skillKey,
      );
      await prepareWorkshopWorkspaceRelocation(
        state.workspaceDir,
        [{ source: record.target.skillDir, destination }],
        state.env,
      );
      const db = openOpenClawStateDatabase({ env: state.env }).db;
      const receipts = () =>
        db
          .prepare("SELECT * FROM migration_sources WHERE migration_kind = ?")
          .all(WORKSPACE_CONTENT_RELOCATION_MIGRATION_KIND);
      const beforeReceipts = receipts();
      expect(beforeReceipts).toEqual([expect.objectContaining({ status: "prepared" })]);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.rename(record.target.skillDir, destination);
      const before = {
        workspace: await readWorkspaceStateSnapshot(state.workspaceDir, {
          env: state.env,
          readOnly: true,
        }),
        files: await fileHashes(destination),
      };

      await migrateLegacySkillWorkshopProposals({ config, env });

      expect(receipts()).toEqual(beforeReceipts);
      expect(
        await readWorkspaceStateSnapshot(state.workspaceDir, { env: state.env, readOnly: true }),
      ).toEqual(before.workspace);
      expect(await fileHashes(destination)).toEqual(before.files);
    });
  });
});
