import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { autoMigrateLegacyState } from "./state-migrations.doctor.js";

async function write(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

afterEach(async () => {
  await closeStateDatabaseForTest();
});

it.each([false, true])(
  "D1: Doctor exports retired proposals to the drafts inbox and preserves failed exports (blocked=%s)",
  async (blocked) => {
    const state = await createOpenClawTestState({ prefix: "workshop-doctor-contract-" });
    const agentDir = state.agentDir("ops");
    const cfg = { agents: { entries: { ops: { agentDir } } } };
    const proposalRoot = state.statePath("skill-workshop", "proposals");
    const drafts = path.join(agentDir, "workshop-skills", ".drafts");
    const earlierExport = path.join(agentDir, "workshop-skills", ".archive", ".retired-proposals");
    const skillDir = path.join(state.workspaceDir, "skills", "deploy");
    const skillFile = path.join(skillDir, "SKILL.md");
    const databasePath = openOpenClawStateDatabase({ env: state.env }).path;
    await closeStateDatabaseForTest();
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(`PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;
      CREATE TABLE skill_workshop_proposals (proposal_id TEXT NOT NULL PRIMARY KEY, record_json TEXT NOT NULL, owner_agent_id TEXT, status TEXT NOT NULL) STRICT;
      CREATE TABLE skill_workshop_proposal_rollbacks (proposal_id TEXT NOT NULL PRIMARY KEY, written_at TEXT NOT NULL, target_skill_file TEXT NOT NULL, action TEXT NOT NULL, previous_content_hash TEXT, previous_content TEXT, support_files_json TEXT) STRICT;
      INSERT INTO skill_workshop_proposals VALUES ('pending-procedure-1', '{"draftFile":"PROPOSAL.md"}', 'ops', 'pending');
      INSERT INTO skill_workshop_proposals VALUES ('quarantined-procedure-1', '{"draftFile":"PROPOSAL.md"}', 'ops', 'quarantined');`);
      db.prepare(
        "INSERT INTO skill_workshop_proposals VALUES ('unfinished-procedure-1', ?, 'ops', 'pending')",
      ).run(
        JSON.stringify({
          draftFile: "PROPOSAL.md",
          target: { skillDir, skillFile },
          supportFiles: [
            {
              path: "references/notes.md",
              hash: createHash("sha256").update("new notes\n").digest("hex"),
            },
          ],
        }),
      );
      db.prepare(
        "INSERT INTO skill_workshop_proposal_rollbacks VALUES ('unfinished-procedure-1', '2026-01-01T00:00:00Z', ?, 'update', ?, '# Before\n', ?)",
      ).run(
        skillFile,
        createHash("sha256").update("# Before\n").digest("hex"),
        JSON.stringify([
          { path: "references/notes.md", existed: true, previousContent: "old notes\n" },
        ]),
      );
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    try {
      await write(path.join(proposalRoot, "pending-procedure-1", "PROPOSAL.md"), "# Pending\n");
      await write(
        path.join(proposalRoot, "quarantined-procedure-1", "PROPOSAL.md"),
        "# Quarantined\n",
      );
      await write(path.join(proposalRoot, "unfinished-procedure-1", "PROPOSAL.md"), "# Draft\n");
      await write(
        path.join(proposalRoot, "unfinished-procedure-1", "references", "notes.md"),
        "new notes\n",
      );
      await write(
        path.join(proposalRoot, "legacy-procedure-1", "proposal.json"),
        JSON.stringify({ status: "pending", draftFile: "PROPOSAL.md", origin: { agentId: "ops" } }),
      );
      await write(path.join(proposalRoot, "legacy-procedure-1", "PROPOSAL.md"), "# Legacy\n");
      await write(skillFile, "# Before\n");
      await write(path.join(skillDir, "references", "notes.md"), "new notes\n");
      // An earlier Doctor exported drafts under the archive; they move into the inbox too.
      if (blocked) {
        await write(drafts, "operator-owned blocker\n");
      } else {
        await write(path.join(earlierExport, "earlier-procedure-1", "SKILL.md"), "# Earlier\n");
      }
      const run = () =>
        autoMigrateLegacyState({
          cfg,
          env: state.env,
          homedir: () => state.home,
          doctorOnlyStateMigrations: true,
          legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        });
      const result = await run();
      const receipt = result.stepReceipts.find((entry) => entry.id === "skill-workshop");
      expect(receipt).toBeDefined();
      if (blocked) {
        expect(result.warnings.join("\n")).toContain("proposal");
        expect(
          await fs.readFile(path.join(proposalRoot, "pending-procedure-1", "PROPOSAL.md"), "utf8"),
        ).toBe("# Pending\n");
        await closeStateDatabaseForTest();
        const reader = new DatabaseSync(databasePath);
        try {
          expect(
            reader.prepare("SELECT count(*) AS n FROM skill_workshop_proposals").get(),
          ).toMatchObject({ n: 3 });
        } finally {
          reader.close();
        }
      } else {
        expect(result.warnings).toEqual([]);
        for (const [name, content] of [
          ["pending", "# Pending\n"],
          ["quarantined", "# Quarantined\n"],
          ["legacy", "# Legacy\n"],
          ["earlier", "# Earlier\n"],
        ]) {
          expect(
            await fs.readFile(path.join(drafts, `${name}-procedure-1`, "SKILL.md"), "utf8"),
          ).toBe(content);
        }
        expect(await fs.readFile(path.join(skillDir, "references", "notes.md"), "utf8")).toBe(
          "old notes\n",
        );
        await expect(fs.stat(proposalRoot)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(earlierExport)).rejects.toMatchObject({ code: "ENOENT" });
        expect(result.changes).toContain("Retired the Skill Workshop proposal tables.");
        expect((await run()).changes).not.toContain("Retired the Skill Workshop proposal tables.");
        await closeStateDatabaseForTest();
        const reader = new DatabaseSync(databasePath);
        try {
          expect(
            reader
              .prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'skill_workshop_proposal%'")
              .all(),
          ).toEqual([]);
        } finally {
          reader.close();
        }
      }
    } finally {
      await state.cleanup();
    }
  },
);
