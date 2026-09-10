import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadCronJobsStoreWithConfigJobsReadOnly,
  resolveCronJobsStorePathFromConfig,
  saveCronStore,
} from "../cron/store.js";
import type { CronJob } from "../cron/types.js";
import { createCoreHealthChecks } from "../flows/doctor-core-checks.js";
import { exitCodeFromFindings, runDoctorLintChecks } from "../flows/doctor-lint-flow.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { createSkillProposalEvent } from "../skills/workshop/plugin-hooks.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import { appendSkillProposalEvent } from "../skills/workshop/store-sqlite-event.js";
import { importLegacySkillProposal } from "../skills/workshop/store.js";
import type { SkillProposalRecord } from "../skills/workshop/types.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { collectDoctorSkillWorkshopBackupResources } from "./doctor-skill-workshop-readonly.js";
import {
  inspectLegacySkillWorkshopMigration,
  migrateLegacySkillWorkshopProposals,
} from "./doctor-skill-workshop-sqlite.js";
import {
  createAppliedLegacyProposal,
  seedLegacyV15ProposalRows,
} from "./doctor-skill-workshop-sqlite.test-support.js";

async function snapshotDatabase(databasePath: string) {
  const database = openNodeSqliteDatabase(databasePath, { readOnly: true });
  try {
    const stat = await fs.stat(databasePath);
    return {
      device: stat.dev,
      inode: stat.ino,
      mode: stat.mode,
      digest: createHash("sha256")
        .update(await fs.readFile(databasePath))
        .digest("hex"),
      version: database.prepare("PRAGMA user_version").get(),
      schema: database
        .prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name")
        .all(),
    };
  } finally {
    database.close();
  }
}

describe("read-only Skill Workshop migration inspection", () => {
  it("reports each stale automation field after relocation without changing stored state", async () => {
    await withOpenClawTestState({ label: "workshop-automation-paths" }, async (state) => {
      const config: OpenClawConfig = {
        agents: { entries: { main: { workspace: state.workspaceDir } } },
      };
      const legacy = path.join(state.workspaceDir, "skills", "relocated");
      const content = "---\nname: relocated\ndescription: Saved procedure\n---\n\n# Saved\n";
      const record = createAppliedLegacyProposal({
        id: "relocated-20260901-1234567890",
        title: "Saved procedure",
        description: "Saved procedure",
        content,
        target: { skillKey: "relocated", skillDir: legacy },
      });
      await fs.mkdir(path.join(legacy, "scripts"), { recursive: true });
      await fs.writeFile(record.target.skillFile, content);
      await fs.writeFile(path.join(legacy, "scripts", "check.sh"), "printf ready\n");
      importLegacySkillProposal({ record, ownerAgentId: "main", store: { env: state.env } });
      appendSkillProposalEvent(
        openOpenClawStateDatabase({ env: state.env }).db,
        createSkillProposalEvent({
          record,
          type: "applied",
          payload: { targetSkillFile: record.target.skillFile },
        }),
      );
      const job = (id: string, payload: CronJob["payload"]): CronJob => ({
        id,
        name: id,
        agentId: "main",
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 2,
        schedule: { kind: "every", everyMs: 86400000, anchorMs: 1 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload,
        state: { nextRunAtMs: 86400001 },
      });
      const jobs = [
        job("command", {
          kind: "command",
          argv: [
            "/bin/sh",
            `${legacy}/scripts/check.sh`,
            `${legacy}-other/check.sh`,
            `sh ${legacy}/scripts/check.sh`,
            `${legacy}.other/check.sh`,
          ],
          cwd: legacy,
        }),
        {
          ...job("condition", {
            kind: "agentTurn",
            message: `Private prose: read ${legacy}/scripts/check.sh.`,
          }),
          trigger: {
            script: `const result = await exec({ command: '/bin/sh ${legacy}/scripts/check.sh' }); json({ fire: false });`,
          },
        },
        job("missing", { kind: "command", argv: ["/bin/sh", `${legacy}/scripts/not-created.sh`] }),
      ];
      const storePath = resolveCronJobsStorePathFromConfig(config, state.env);
      await saveCronStore(storePath, { version: 1, jobs });
      const before = await loadCronJobsStoreWithConfigJobsReadOnly(storePath, state.env);
      await migrateLegacySkillWorkshopProposals({ config, env: state.env });
      await expect(fs.access(legacy)).rejects.toMatchObject({ code: "ENOENT" });
      closeOpenClawStateDatabaseForTest();
      const databasePath = resolveOpenClawStateSqlitePath(state.env);
      const databaseBefore = await snapshotDatabase(databasePath);
      const filesBefore = (await fs.readdir(state.stateDir, { recursive: true })).toSorted();
      const destination = path.join(
        resolveWorkshopSkillsDir(config, "main", state.env),
        "relocated",
      );

      for (let inspection = 0; inspection < 2; inspection += 1) {
        const result = await runDoctorLintChecks(
          { mode: "lint", runtime: { log() {}, error() {}, exit() {} }, cfg: config },
          { checks: createCoreHealthChecks(), onlyIds: ["core/doctor/skill-workshop-relocation"] },
        );
        expect(
          result.findings.map(({ target, path: field }) => `${target}:${field}`).toSorted(),
        ).toEqual([
          "command:payload.argv[1]",
          "command:payload.argv[3]",
          "command:payload.cwd",
          "condition:payload.message",
          "condition:trigger.script",
          "missing:payload.argv[1]",
        ]);
        const find = (id: string, field: string) =>
          result.findings.find((finding) => finding.target === id && finding.path === field);
        expect(find("command", "payload.argv[1]")?.fixHint).toContain(
          `${destination}/scripts/check.sh`,
        );
        expect(find("command", "payload.cwd")?.fixHint).toContain(destination);
        expect(find("missing", "payload.argv[1]")?.fixHint).toContain("unresolved");
        expect(find("condition", "trigger.script")?.fixHint).toContain("unresolved");
        expect(find("condition", "payload.message")?.message).not.toContain("Private prose");
        expect(await loadCronJobsStoreWithConfigJobsReadOnly(storePath, state.env)).toEqual(before);
        expect(await snapshotDatabase(databasePath)).toEqual(databaseBefore);
        expect((await fs.readdir(state.stateDir, { recursive: true })).toSorted()).toEqual(
          filesBefore,
        );
      }
    });
  });

  it("identifies remaining targets after retargeting without recommending an identical repair", async () => {
    await withOpenClawTestState({ label: "workshop-remaining-targets" }, async (state) => {
      const config = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
      const blockedWorkspace = state.path("old-workspace");
      await fs.mkdir(path.join(blockedWorkspace, ".openclaw"), { recursive: true });
      await fs.writeFile(path.join(blockedWorkspace, ".openclaw", "workspace-state.json"), "{}");
      const records = [
        { name: "eligible", workspaceDir: state.workspaceDir },
        { name: "blocked", workspaceDir: blockedWorkspace },
      ].map(({ name, workspaceDir }) => {
        const record: SkillProposalRecord = createAppliedLegacyProposal({
          id: `${name}-20260901-1234567890`,
          title: name,
          description: "Saved procedure",
          content: "# Saved\n",
          target: { skillKey: name, skillDir: path.join(workspaceDir, "skills", name) },
        });
        record.status = "pending";
        delete record.appliedAt;
        return record;
      });
      for (const record of records) {
        importLegacySkillProposal({ record, ownerAgentId: "main", store: { env: state.env } });
      }
      const [eligible, blocked] = records;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const migration = await migrateLegacySkillWorkshopProposals({ config, env: state.env });
        if (attempt === 0) {
          expect(migration.changes.join("\n")).toContain("retargeted 1 proposal");
        } else {
          expect(migration.changes).toEqual([]);
        }
        expect(migration.warnings.join("\n")).toContain(
          "Legacy workspace setup state requires migration",
        );
        const result = await runDoctorLintChecks(
          { mode: "doctor", runtime: { log() {}, error() {}, exit() {} }, cfg: config },
          { checks: createCoreHealthChecks(), onlyIds: ["core/doctor/skill-workshop-relocation"] },
        );
        expect(result.findings).toHaveLength(1);
        const finding = result.findings[0]!;
        expect(finding.message).toContain(blocked!.id);
        expect(finding.message).toContain(blocked!.target.skillDir);
        expect(finding.message).not.toContain(eligible!.id);
        expect(finding.fixHint).not.toContain("Run `openclaw doctor --fix`");
        expect(finding.fixHint).toContain("migration warnings");
      }
    });
  });

  it.each([
    { roots: [], proposal: false, preserved: 0, automatic: false },
    { roots: ["eligible"], proposal: false, preserved: 0, automatic: true },
    { roots: ["ambiguous"], proposal: false, preserved: 1, automatic: false },
    { roots: ["invalid"], proposal: false, preserved: 1, automatic: false },
    { roots: ["eligible", "ambiguous", "invalid"], proposal: false, preserved: 2, automatic: true },
    { roots: ["ambiguous"], proposal: true, preserved: 1, automatic: true },
  ])(
    "gives truthful read-only lint remediation for roots=$roots proposal=$proposal",
    async ({ roots, proposal, preserved, automatic }) => {
      await withOpenClawTestState({ layout: "split" }, async (state) => {
        const config = {
          agents: {
            entries: {
              main: { workspace: state.workspaceDir },
              alpha: { workspace: path.join(state.root, "shared-workspace") },
              beta: { workspace: path.join(state.root, "shared-workspace") },
            },
          },
        };
        await state.writeConfig(config);
        const configBefore = await fs.readFile(state.configPath);
        const manifests = await Promise.all(
          roots.map(async (kind, index) => {
            const contents = JSON.stringify({
              schema: kind === "invalid" ? "invalid" : "openclaw.skill-collection-backup.v1",
              id: "legacy-backup",
              createdAt: "2026-09-01T00:00:00.000Z",
              workspaceDir:
                kind === "ambiguous" ? config.agents.entries.alpha.workspace : state.workspaceDir,
              skillDirs: [],
              resultSkillDirs: [],
              resultSkillHashes: {},
            });
            const file = await state.writeText(
              `skill-workshop/collection-backups/${index.toString(16).padStart(16, "0")}/legacy-backup/manifest.json`,
              contents,
            );
            return { file, contents };
          }),
        );
        if (proposal) {
          importLegacySkillProposal({
            record: createAppliedLegacyProposal({
              id: "readonly-workshop-20260907-1234567890",
              title: "Legacy Workshop",
              description: "Pending relocation",
              content: "# Preserved\n",
              target: {
                skillKey: "legacy",
                skillDir: path.join(state.workspaceDir, "skills", "legacy"),
              },
            }),
            ownerAgentId: "main",
            store: { env: state.env },
          });
        }
        closeOpenClawStateDatabaseForTest();
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        const databaseBefore = proposal ? await snapshotDatabase(databasePath) : undefined;
        const filesBefore = (await fs.readdir(state.stateDir, { recursive: true })).toSorted();

        const result = await runDoctorLintChecks(
          { mode: "lint", runtime: { log() {}, error() {}, exit() {} }, cfg: config },
          {
            checks: createCoreHealthChecks().filter((check) => "detect" in check),
            onlyIds: ["core/doctor/skill-workshop-relocation"],
          },
        );

        expect(result.checksRun).toBe(1);
        expect(result.findings).toHaveLength(roots.length || proposal ? 1 : 0);
        expect(exitCodeFromFindings(result.findings)).toBe(roots.length || proposal ? 1 : 0);
        if (result.findings.length > 0) {
          const finding = result.findings[0]!;
          expect(finding.severity).toBe("warning");
          expect(finding.fixHint?.includes("Run `openclaw doctor --fix`")).toBe(automatic);
          expect(finding.fixHint).not.toContain("retire legacy backup roots");
          if (preserved > 0) {
            expect(finding.message).toContain(`${preserved} preserved`);
            expect(finding.fixHint).toMatch(/manual/i);
            expect(finding.fixHint).toContain("workspace ownership");
            expect(finding.fixHint).toContain("manifests");
          }
        }
        expect((await fs.readdir(state.stateDir, { recursive: true })).toSorted()).toEqual(
          filesBefore,
        );
        expect(await fs.readFile(state.configPath)).toEqual(configBefore);
        for (const manifest of manifests) {
          expect(await fs.readFile(manifest.file, "utf8")).toBe(manifest.contents);
        }
        if (proposal) {
          expect(await snapshotDatabase(databasePath)).toEqual(databaseBefore);
        } else {
          await expect(fs.access(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
        }
      });
    },
  );

  it.each([
    { version: 16, sourcePresent: true },
    { version: 16, sourcePresent: false },
    { version: 15, sourcePresent: true },
    { version: 15, sourcePresent: false },
  ])(
    "preserves schema $version with source present=$sourcePresent",
    async ({ version, sourcePresent }) => {
      await withOpenClawTestState({ layout: "split" }, async (state) => {
        const config = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
        const content =
          "---\nname: readonly-workshop\ndescription: Preserved procedure\n---\n\n# Keep\n";
        const legacyDir = path.join(state.workspaceDir, "skills", "readonly-workshop");
        const record = createAppliedLegacyProposal({
          id: "readonly-workshop-20260905-1234567890",
          title: "Create Readonly Workshop",
          description: "Preserved procedure",
          content,
          target: { skillKey: "readonly-workshop", skillDir: legacyDir },
        });
        const skillFile = sourcePresent
          ? record.target.skillFile
          : path.join(
              resolveWorkshopSkillsDir(config, "main", state.env),
              "readonly-workshop",
              "SKILL.md",
            );
        await fs.mkdir(path.dirname(skillFile), { recursive: true });
        await fs.writeFile(skillFile, content);
        if (version === 15) {
          seedLegacyV15ProposalRows(state.env, [
            { record, workspaceDir: state.workspaceDir, claimReleasedTime: null },
          ]);
        } else {
          importLegacySkillProposal({ record, ownerAgentId: "main", store: { env: state.env } });
        }
        closeOpenClawStateDatabaseForTest();
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        const seed = openNodeSqliteDatabase(databasePath);
        try {
          // Empty feature tables may be absent under LAZY_ADDITIVE_STATE_TABLES.
          seed.exec(`
          DROP TABLE skill_workshop_proposal_events;
          DROP TABLE skill_workshop_proposal_rollbacks;
          DROP TABLE skill_workshop_collection_reviews;
        `);
        } finally {
          seed.close();
        }
        const before = await snapshotDatabase(databasePath);

        await expect(
          inspectLegacySkillWorkshopMigration({ config, env: state.env }),
        ).resolves.toEqual({
          externalProposalCount: 1,
          externalProposalDetails: expect.any(Array),
          externalProposalCountsByAgent: { main: 1 },
          legacyBackupRootCount: 0,
          preservedLegacyBackupRootCount: 0,
        });

        expect(await collectDoctorSkillWorkshopBackupResources({ config, env: state.env })).toEqual(
          [
            { path: legacyDir, kind: "directory" },
            {
              path: path.join(
                resolveWorkshopSkillsDir(config, "main", state.env),
                "readonly-workshop",
              ),
              kind: "directory",
            },
          ].toSorted((left, right) => left.path.localeCompare(right.path)),
        );

        closeOpenClawStateDatabaseForTest();
        expect(await snapshotDatabase(databasePath)).toEqual(before);
        expect(await fs.readFile(skillFile, "utf8")).toBe(content);
      });
    },
  );

  it("includes legacy sidecar targets without creating SQLite or capturing the full workspace", async () => {
    await withOpenClawTestState({ label: "workshop-backup-sidecars" }, async (state) => {
      const config = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
      const content = "# Retained skill\n";
      const source = path.join(state.workspaceDir, ".agents", "skills", "retained");
      const record = createAppliedLegacyProposal({
        id: "retained-20260905-1234567890",
        title: "Retained",
        description: "Retained skill",
        content,
        target: { skillKey: "retained", skillDir: source },
      });
      await state.writeJson(`skill-workshop/proposals/${record.id}/proposal.json`, record);
      await state.writeText(`skill-workshop/proposals/${record.id}/PROPOSAL.md`, content);
      const resources = await collectDoctorSkillWorkshopBackupResources({ config, env: state.env });
      expect(resources).toEqual(
        [
          { path: source, kind: "directory" },
          {
            path: path.join(resolveWorkshopSkillsDir(config, "main", state.env), "retained"),
            kind: "directory",
          },
          { path: state.statePath("skill-workshop", "proposals"), kind: "directory" },
          { path: state.statePath("skill-workshop", "recovery", "proposals"), kind: "directory" },
        ].toSorted((left, right) => left.path.localeCompare(right.path)),
      );
      await expect(fs.access(resolveOpenClawStateSqlitePath(state.env))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        await fs.readFile(
          state.statePath("skill-workshop", "proposals", record.id, "proposal.json"),
          "utf8",
        ),
      ).toContain(record.id);
    });
  });

  it("preserves proposal status filters, ownership precedence, and unknown owner counts", async () => {
    await withOpenClawTestState({ layout: "split" }, async (state) => {
      const config = {
        agents: {
          entries: {
            main: { workspace: state.workspaceDir },
            other: { workspace: path.join(state.root, "other-workspace") },
          },
        },
      };
      const cases: Array<{
        name: string;
        owner: string | null;
        kind?: SkillProposalRecord["kind"];
        status?: SkillProposalRecord["status"];
        origin?: SkillProposalRecord["origin"];
        owned?: boolean;
        unknownWorkspace?: boolean;
      }> = [
        { name: "pending-create", owner: "MAIN", status: "pending", origin: { agentId: "other" } },
        { name: "pending-update", owner: "main", kind: "update", status: "pending" },
        { name: "applied-create", owner: "main" },
        { name: "applied-update", owner: "main", kind: "update" },
        { name: "rejected", owner: "main", status: "rejected" },
        { name: "quarantined", owner: "main", status: "quarantined" },
        { name: "stale", owner: "main", status: "stale" },
        { name: "owned", owner: "main", owned: true },
        { name: "unowned-inside", owner: null, owned: true, origin: { agentId: "main" } },
        {
          name: "origin-agent",
          owner: null,
          origin: { agentId: "other", sessionKey: "agent:main:main" },
        },
        { name: "origin-session", owner: null, origin: { sessionKey: "agent:other:main" } },
        { name: "retired", owner: "retired", origin: { agentId: "main" } },
        { name: "unknown", owner: null, unknownWorkspace: true },
        { name: "workspace-owner", owner: null },
      ];
      for (const sample of cases) {
        const root = sample.owned
          ? resolveWorkshopSkillsDir(config, "main", state.env)
          : path.join(
              sample.unknownWorkspace
                ? path.join(state.root, "unknown-workspace")
                : state.workspaceDir,
              "skills",
            );
        const record: SkillProposalRecord = {
          ...createAppliedLegacyProposal({
            id: `${sample.name}-20260905-1234567890`,
            title: sample.name,
            description: "Ownership classification",
            content: "# Preserved\n",
            target: { skillKey: sample.name, skillDir: path.join(root, sample.name) },
          }),
          kind: sample.kind ?? "create",
          status: sample.status ?? "applied",
          ...(sample.origin ? { origin: sample.origin } : {}),
        };
        importLegacySkillProposal({
          record,
          ownerAgentId: sample.owner ?? "main",
          store: { env: state.env },
        });
      }
      closeOpenClawStateDatabaseForTest();
      const seed = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath(state.env));
      try {
        for (const sample of cases.filter((entry) => entry.owner === null)) {
          seed
            .prepare(
              "UPDATE skill_workshop_proposals SET owner_agent_id = NULL WHERE proposal_id = ?",
            )
            .run(`${sample.name}-20260905-1234567890`);
        }
      } finally {
        seed.close();
      }

      await expect(
        inspectLegacySkillWorkshopMigration({ config, env: state.env }),
      ).resolves.toEqual({
        externalProposalCount: 9,
        externalProposalDetails: expect.any(Array),
        externalProposalCountsByAgent: { main: 5, other: 2, retired: 1, unknown: 1 },
        legacyBackupRootCount: 0,
        preservedLegacyBackupRootCount: 0,
      });
    });
  });
});
