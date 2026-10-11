import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { retireSkillWorkshopProposals } from "./doctor-skill-workshop-retire-proposals.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

const GENERATION = "generations/123e4567-e89b-42d3-a456-426614174000";

// Retired shape from an older release, including the review index Doctor must drop first.
const RETIRED_TABLES = `
  CREATE TABLE skill_workshop_proposals (
    proposal_id TEXT NOT NULL PRIMARY KEY, record_json TEXT NOT NULL,
    owner_agent_id TEXT, status TEXT NOT NULL
  ) STRICT;
  CREATE TABLE skill_workshop_proposal_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, proposal_id TEXT NOT NULL,
    FOREIGN KEY (proposal_id) REFERENCES skill_workshop_proposals(proposal_id) ON DELETE CASCADE
  ) STRICT;
  CREATE TABLE skill_workshop_proposal_rollbacks (
    proposal_id TEXT NOT NULL PRIMARY KEY,
    written_at TEXT NOT NULL,
    target_skill_file TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('create', 'update')),
    previous_content_hash TEXT,
    previous_content TEXT,
    support_files_json TEXT,
    FOREIGN KEY (proposal_id) REFERENCES skill_workshop_proposals(proposal_id) ON DELETE CASCADE
  ) STRICT;
  CREATE TABLE skill_workshop_collection_reviews (
    review_id TEXT NOT NULL PRIMARY KEY, owner_agent_id TEXT NOT NULL, create_time INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX idx_skill_workshop_collection_reviews_owner_time
    ON skill_workshop_collection_reviews(owner_agent_id, create_time DESC, review_id);
`;

function write(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function retiredTableNames(env: NodeJS.ProcessEnv) {
  return openOpenClawStateDatabase({ env })
    .db.prepare(
      `SELECT name FROM sqlite_schema
        WHERE name LIKE 'skill_workshop_proposal%' OR name LIKE '%skill_workshop_collection_reviews%'`,
    )
    .all();
}

it("exports pending drafts from retired tables and legacy files, then drops the tables once", async () => {
  const root = tempDirs.make("openclaw-retire-proposals-");
  const stateDir = path.join(root, "state");
  const env = { HOME: root, OPENCLAW_STATE_DIR: stateDir };
  const mainDir = path.join(root, "main-agent");
  const opsDir = path.join(root, "ops-agent");
  const config: OpenClawConfig = {
    agents: { entries: { main: { agentDir: mainDir }, ops: { agentDir: opsDir } } },
  };
  const proposalsDir = path.join(stateDir, "skill-workshop", "proposals");
  const mainExports = path.join(mainDir, "workshop-skills", ".archive", ".retired-proposals");
  const opsExports = path.join(opsDir, "workshop-skills", ".archive", ".retired-proposals");

  openOpenClawStateDatabase({ env }).db.exec(`
    ${RETIRED_TABLES}
    INSERT INTO skill_workshop_proposals VALUES
      ('pending-procedure-1', '{"draftFile":"${GENERATION}/PROPOSAL.md","supportFiles":[{"path":"references/notes.md"}]}', 'ops', 'pending'),
      ('quarantined-procedure-1', '{"draftFile":"PROPOSAL.md","origin":{"agentId":"main"}}', NULL, 'quarantined'),
      ('applied-procedure-1', '{"draftFile":"PROPOSAL.md"}', 'main', 'applied');
    INSERT INTO skill_workshop_proposal_events (proposal_id) VALUES ('pending-procedure-1');
    INSERT INTO skill_workshop_collection_reviews VALUES ('review', 'main', 1);
  `);
  write(path.join(proposalsDir, "pending-procedure-1", GENERATION, "PROPOSAL.md"), "# Pending\n");
  write(
    path.join(proposalsDir, "pending-procedure-1", GENERATION, "references", "notes.md"),
    "notes\n",
  );
  write(path.join(proposalsDir, "quarantined-procedure-1", "PROPOSAL.md"), "# Quarantined\n");
  write(path.join(proposalsDir, "applied-procedure-1", "PROPOSAL.md"), "# Applied\n");
  write(
    path.join(proposalsDir, "legacy-procedure-1", "proposal.json"),
    '{"status":"pending","draftFile":"PROPOSAL.md","origin":{"sessionKey":"agent:main:main"}}',
  );
  write(path.join(proposalsDir, "legacy-procedure-1", "PROPOSAL.md"), "# Legacy\n");
  // An earlier export is never overwritten.
  write(path.join(mainExports, "quarantined-procedure-1", "SKILL.md"), "# Kept export\n");

  await expect(retireSkillWorkshopProposals({ config, env })).resolves.toEqual({
    changes: [
      `Exported 1 pending Skill Workshop proposal draft to ${opsExports}${path.sep}.`,
      `Exported 1 pending Skill Workshop proposal draft to ${mainExports}${path.sep}.`,
      "Retired the Skill Workshop proposal tables.",
      `Removed retired Skill Workshop proposal files from ${proposalsDir}.`,
    ],
    warnings: [],
  });

  const read = (...parts: string[]) => fs.readFileSync(path.join(...parts), "utf8");
  expect(read(opsExports, "pending-procedure-1", "SKILL.md")).toBe("# Pending\n");
  expect(read(opsExports, "pending-procedure-1", "references", "notes.md")).toBe("notes\n");
  expect(read(mainExports, "quarantined-procedure-1", "SKILL.md")).toBe("# Kept export\n");
  expect(read(mainExports, "legacy-procedure-1", "SKILL.md")).toBe("# Legacy\n");
  expect(fs.readdirSync(mainExports).toSorted()).toEqual([
    "legacy-procedure-1",
    "quarantined-procedure-1",
  ]);
  expect(fs.existsSync(proposalsDir)).toBe(false);
  expect(retiredTableNames(env)).toEqual([]);

  await expect(retireSkillWorkshopProposals({ config, env })).resolves.toEqual({
    changes: [],
    warnings: [],
  });
});

it("keeps legacy bundles without a provable owner, record, or draft until every bundle is exported", async () => {
  const root = tempDirs.make("openclaw-retire-legacy-proposals-");
  const stateDir = path.join(root, "state");
  const env = { HOME: root, OPENCLAW_STATE_DIR: stateDir };
  const opsDir = path.join(root, "ops-agent");
  const opsWorkspace = path.join(root, "ops-workspace");
  const config: OpenClawConfig = {
    agents: {
      entries: {
        main: { agentDir: path.join(root, "main-agent") },
        ops: { agentDir: opsDir, workspace: opsWorkspace },
      },
    },
  };
  const proposalsDir = path.join(stateDir, "skill-workshop", "proposals");
  const opsExports = path.join(opsDir, "workshop-skills", ".archive", ".retired-proposals");
  const bundle = (id: string, record?: object) => {
    write(path.join(proposalsDir, id, "PROPOSAL.md"), `# ${id}\n`);
    if (record) {
      write(path.join(proposalsDir, id, "proposal.json"), JSON.stringify(record));
    }
  };
  // The legacy target skill sits in ops' workspace, which names its owner.
  bundle("workspace-procedure-1", {
    status: "pending",
    target: { skillDir: path.join(opsWorkspace, "skills", "deploy") },
  });
  bundle("unowned-procedure-1", { status: "quarantined" });
  bundle("orphan-procedure-1");
  // A lost draft must not take its remaining support files down with the bundle.
  write(
    path.join(proposalsDir, "draftless-procedure-1", "proposal.json"),
    JSON.stringify({
      status: "pending",
      origin: { agentId: "ops" },
      supportFiles: [{ path: "references/notes.md" }],
    }),
  );
  write(path.join(proposalsDir, "draftless-procedure-1", "references", "notes.md"), "notes\n");

  const first = await retireSkillWorkshopProposals({ config, env });
  expect(first.changes).toEqual([
    `Exported 1 pending Skill Workshop proposal draft to ${opsExports}${path.sep}.`,
  ]);
  expect(first.warningDisposition).toBe("recoverable");
  expect(first.warnings.toSorted()).toEqual([
    expect.stringMatching(/^No configured agent owns Skill Workshop proposal unowned-procedure-1;/),
    expect.stringMatching(/^Skill Workshop proposal draftless-procedure-1 has no draft; kept /),
    expect.stringMatching(/^Skill Workshop proposal orphan-procedure-1 has no record;/),
  ]);
  expect(fs.readFileSync(path.join(opsExports, "workspace-procedure-1", "SKILL.md"), "utf8")).toBe(
    "# workspace-procedure-1\n",
  );
  expect(fs.readdirSync(proposalsDir).toSorted()).toEqual([
    "draftless-procedure-1",
    "orphan-procedure-1",
    "unowned-procedure-1",
    "workspace-procedure-1",
  ]);

  // After the operator resolves the flagged bundles, the legacy tree is retired.
  fs.rmSync(path.join(proposalsDir, "draftless-procedure-1"), { recursive: true });
  fs.rmSync(path.join(proposalsDir, "orphan-procedure-1"), { recursive: true });
  fs.rmSync(path.join(proposalsDir, "unowned-procedure-1"), { recursive: true });
  await expect(retireSkillWorkshopProposals({ config, env })).resolves.toEqual({
    changes: [`Removed retired Skill Workshop proposal files from ${proposalsDir}.`],
    warnings: [],
  });
  expect(fs.existsSync(proposalsDir)).toBe(false);
});

it.each([
  { case: "a NULL owner and no provable agent", owner: "NULL" },
  { case: "an owner that is no longer configured", owner: "'removed'" },
])("keeps a proposal with $case out of every archive", async ({ owner }) => {
  const root = tempDirs.make("openclaw-retire-unowned-proposal-");
  const stateDir = path.join(root, "state");
  const env = { HOME: root, OPENCLAW_STATE_DIR: stateDir };
  const mainDir = path.join(root, "main-agent");
  const config: OpenClawConfig = {
    agents: {
      entries: {
        main: { agentDir: mainDir },
        ops: { agentDir: path.join(root, "ops-agent") },
      },
    },
  };
  const proposalDir = path.join(stateDir, "skill-workshop", "proposals", "unowned-procedure-1");
  openOpenClawStateDatabase({ env }).db.exec(`
    ${RETIRED_TABLES}
    INSERT INTO skill_workshop_proposals VALUES
      ('unowned-procedure-1', '{"draftFile":"PROPOSAL.md"}', ${owner}, 'pending');
  `);
  write(path.join(proposalDir, "PROPOSAL.md"), "# Unowned\n");

  const first = await retireSkillWorkshopProposals({ config, env });
  expect(first).toEqual({
    changes: [],
    warnings: [
      `No configured agent owns Skill Workshop proposal unowned-procedure-1; kept ${proposalDir}. To keep it, add its agent back to your config and rerun openclaw doctor --fix, or have an agent save that whole directory (draft and support files) with /learn and then delete the directory; otherwise delete the directory and rerun openclaw doctor --fix.`,
    ],
    warningDisposition: "recoverable",
  });
  expect(fs.existsSync(path.join(mainDir, "workshop-skills", ".archive"))).toBe(false);
  expect(fs.readFileSync(path.join(proposalDir, "PROPOSAL.md"), "utf8")).toBe("# Unowned\n");
  expect(retiredTableNames(env)).not.toEqual([]);

  // Once the operator has copied the draft and removed its directory, nothing is left to keep.
  fs.rmSync(proposalDir, { recursive: true });
  const second = await retireSkillWorkshopProposals({ config, env });
  expect(second.changes).toContain("Retired the Skill Workshop proposal tables.");
  expect(retiredTableNames(env)).toEqual([]);
});

it("undoes an apply that stopped before SKILL.md, then retires its rollback", async () => {
  const root = tempDirs.make("openclaw-retire-unfinished-apply-");
  const stateDir = path.join(root, "state");
  const env = { HOME: root, OPENCLAW_STATE_DIR: stateDir };
  const opsDir = path.join(root, "ops-agent");
  const config: OpenClawConfig = { agents: { entries: { ops: { agentDir: opsDir } } } };
  const skillDir = path.join(root, "ops-workspace", "skills", "deploy");
  const skillFile = path.join(skillDir, "SKILL.md");
  const record = {
    draftFile: "PROPOSAL.md",
    target: { skillDir, skillFile },
    supportFiles: [
      { path: "references/replaced.md", hash: sha256Hex("new replaced\n") },
      { path: "references/added.md", hash: sha256Hex("new added\n") },
    ],
  };
  const rollbackSupport = [
    { path: "references/replaced.md", existed: true, previousContent: "old replaced\n" },
    { path: "references/added.md", existed: false },
  ];
  const database = openOpenClawStateDatabase({ env }).db;
  database.exec(RETIRED_TABLES);
  database
    .prepare(
      "INSERT INTO skill_workshop_proposals VALUES ('deploy-procedure-1', ?, 'ops', 'pending')",
    )
    .run(JSON.stringify(record));
  database
    .prepare(
      `INSERT INTO skill_workshop_proposal_rollbacks VALUES
        ('deploy-procedure-1', '2026-01-01T00:00:00.000Z', ?, 'update', ?, '# Before\n', ?)`,
    )
    .run(skillFile, sha256Hex("# Before\n"), JSON.stringify(rollbackSupport));
  const bundleDir = path.join(stateDir, "skill-workshop", "proposals", "deploy-procedure-1");
  write(path.join(bundleDir, "PROPOSAL.md"), "# Draft\n");
  write(path.join(bundleDir, "references", "replaced.md"), "new replaced\n");
  write(path.join(bundleDir, "references", "added.md"), "new added\n");
  // The apply wrote both support files, then stopped before its last write, SKILL.md.
  write(skillFile, "# Before\n");
  write(path.join(skillDir, "references", "replaced.md"), "new replaced\n");
  write(path.join(skillDir, "references", "added.md"), "new added\n");

  const result = await retireSkillWorkshopProposals({ config, env });

  expect(result.warnings).toEqual([]);
  expect(result.changes).toContain(
    `Restored ${skillDir} from the unfinished apply of Skill Workshop proposal deploy-procedure-1.`,
  );
  expect(result.changes).toContain("Retired the Skill Workshop proposal tables.");
  expect(fs.readFileSync(skillFile, "utf8")).toBe("# Before\n");
  expect(fs.readFileSync(path.join(skillDir, "references", "replaced.md"), "utf8")).toBe(
    "old replaced\n",
  );
  expect(fs.existsSync(path.join(skillDir, "references", "added.md"))).toBe(false);
  expect(retiredTableNames(env)).toEqual([]);
});

it("frees the skill name when it undoes a create that stopped before SKILL.md", async () => {
  const root = tempDirs.make("openclaw-retire-unfinished-create-");
  const stateDir = path.join(root, "state");
  const env = { HOME: root, OPENCLAW_STATE_DIR: stateDir };
  const config: OpenClawConfig = {
    agents: { entries: { ops: { agentDir: path.join(root, "ops-agent") } } },
  };
  const skillDir = path.join(root, "ops-workspace", "skills", "deploy");
  const skillFile = path.join(skillDir, "SKILL.md");
  const record = {
    target: { skillDir, skillFile },
    supportFiles: [{ path: "references/notes.md", hash: sha256Hex("proposed\n") }],
  };
  const database = openOpenClawStateDatabase({ env }).db;
  database.exec(RETIRED_TABLES);
  database
    .prepare(
      "INSERT INTO skill_workshop_proposals VALUES ('deploy-procedure-1', ?, 'ops', 'pending')",
    )
    .run(JSON.stringify(record));
  database
    .prepare(
      `INSERT INTO skill_workshop_proposal_rollbacks VALUES
        ('deploy-procedure-1', '2026-01-01T00:00:00.000Z', ?, 'create', NULL, NULL, ?)`,
    )
    .run(skillFile, JSON.stringify([{ path: "references/notes.md", existed: false }]));
  write(path.join(skillDir, "references", "notes.md"), "proposed\n");

  const result = await retireSkillWorkshopProposals({ config, env });

  expect(result.changes).toContain("Retired the Skill Workshop proposal tables.");
  expect(fs.existsSync(skillDir)).toBe(false);
});

async function retireUnfinishedApply(live: { skill: string; support: string }) {
  const root = tempDirs.make("openclaw-retire-unfinished-apply-");
  const stateDir = path.join(root, "state");
  const env = { HOME: root, OPENCLAW_STATE_DIR: stateDir };
  const config: OpenClawConfig = {
    agents: { entries: { ops: { agentDir: path.join(root, "ops-agent") } } },
  };
  const skillDir = path.join(root, "ops-workspace", "skills", "deploy");
  const skillFile = path.join(skillDir, "SKILL.md");
  const supportFile = path.join(skillDir, "references", "notes.md");
  const record = {
    target: { skillDir, skillFile },
    supportFiles: [{ path: "references/notes.md", hash: sha256Hex("proposed\n") }],
  };
  const database = openOpenClawStateDatabase({ env }).db;
  database.exec(RETIRED_TABLES);
  database
    .prepare(
      "INSERT INTO skill_workshop_proposals VALUES ('deploy-procedure-1', ?, 'ops', 'pending')",
    )
    .run(JSON.stringify(record));
  database
    .prepare(
      `INSERT INTO skill_workshop_proposal_rollbacks VALUES
        ('deploy-procedure-1', '2026-01-01T00:00:00.000Z', ?, 'update', NULL, '# Before\n', ?)`,
    )
    .run(
      skillFile,
      JSON.stringify([{ path: "references/notes.md", existed: true, previousContent: "before\n" }]),
    );
  write(skillFile, live.skill);
  write(supportFile, live.support);
  const result = await retireSkillWorkshopProposals({ config, env });
  return { result, env, skillDir, skillFile, supportFile };
}

it.each([
  {
    state: "a half-applied support file changed since the apply",
    live: { skill: "# Before\n", support: "edited by hand\n" },
    cause: (supportFile: string) =>
      `Workspace skill target changed before restoration: ${supportFile}`,
  },
  {
    state: "compensation stopped after restoring support files but before SKILL.md",
    live: { skill: "# Proposed\n", support: "before\n" },
    cause: () => "SKILL.md is past its pre-apply content but its support files are not",
  },
])("keeps the rollback when $state", async ({ live, cause }) => {
  const { result, env, skillDir, skillFile, supportFile } = await retireUnfinishedApply(live);

  expect(result.changes).toEqual([]);
  expect(result.warningDisposition).toBe("recoverable");
  expect(result.warnings).toContainEqual(
    expect.stringContaining(
      `Could not undo the unfinished apply of Skill Workshop proposal deploy-procedure-1 in ${skillDir}: Error: ${cause(supportFile)}.`,
    ),
  );
  expect(fs.readFileSync(skillFile, "utf8")).toBe(live.skill);
  expect(fs.readFileSync(supportFile, "utf8")).toBe(live.support);
  expect(retiredTableNames(env)).not.toEqual([]);
});

it("retires the rollback of an apply that finished before its status commit", async () => {
  const live = { skill: "# Proposed\n", support: "proposed\n" };
  const { result, env, skillFile, supportFile } = await retireUnfinishedApply(live);

  expect(result.warnings).toEqual([
    "Skill Workshop proposal deploy-procedure-1 has no draft left to export; retired its record.",
  ]);
  expect(result.changes).toContain("Retired the Skill Workshop proposal tables.");
  expect(fs.readFileSync(skillFile, "utf8")).toBe(live.skill);
  expect(fs.readFileSync(supportFile, "utf8")).toBe(live.support);
  expect(retiredTableNames(env)).toEqual([]);
});
