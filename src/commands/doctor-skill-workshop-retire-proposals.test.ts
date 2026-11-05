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
    proposal_id TEXT NOT NULL PRIMARY KEY, written_at TEXT NOT NULL, target_skill_file TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('create', 'update')),
    previous_content_hash TEXT, previous_content TEXT, support_files_json TEXT,
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

function writeFiles(dir: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    write(path.join(dir, file), content);
  }
}

const read = (...parts: string[]) => fs.readFileSync(path.join(...parts), "utf8");
const retiredTablesMessage = "Retired the Skill Workshop proposal tables.";

function fixture(options: { opsOnly?: boolean; workspace?: boolean } = {}) {
  const root = tempDirs.make("openclaw-retire-");
  const stateDir = path.join(root, "state");
  const env = { HOME: root, OPENCLAW_STATE_DIR: stateDir };
  const mainDir = path.join(root, "main-agent");
  const opsDir = path.join(root, "ops-agent");
  const opsWorkspace = path.join(root, "ops-workspace");
  const entries: NonNullable<OpenClawConfig["agents"]>["entries"] = {
    ...(!options.opsOnly ? { main: { agentDir: mainDir } } : {}),
    ops: { agentDir: opsDir, ...(options.workspace ? { workspace: opsWorkspace } : {}) },
  };
  const config: OpenClawConfig = { agents: { entries } };
  const proposalsDir = path.join(stateDir, "skill-workshop", "proposals");
  const exportsFor = (agentDir: string) => path.join(agentDir, "workshop-skills", ".drafts");
  const skillDir = path.join(opsWorkspace, "skills", "deploy");
  return {
    env,
    mainDir,
    opsWorkspace,
    config,
    proposalsDir,
    mainExports: exportsFor(mainDir),
    opsExports: exportsFor(opsDir),
    skillDir,
    skillFile: path.join(skillDir, "SKILL.md"),
  };
}

function rollbackFixture(
  files: Array<[path: string, proposed: string, previous: string | null]>,
  action: "create" | "update" = "update",
  previousHash: string | null = null,
  draftFile?: string,
) {
  const setup = fixture({ opsOnly: true });
  const { env, skillDir, skillFile } = setup;
  const record = {
    draftFile,
    target: { skillDir, skillFile },
    supportFiles: files.map(([file, proposed]) => ({ path: file, hash: sha256Hex(proposed) })),
  };
  const supportFiles = files.map(([file, , previousContent]) => ({
    path: file,
    existed: previousContent !== null,
    previousContent,
  }));
  const db = openOpenClawStateDatabase({ env }).db;
  db.exec(RETIRED_TABLES);
  db.prepare(
    "INSERT INTO skill_workshop_proposals VALUES ('deploy-procedure-1', ?, 'ops', 'pending')",
  ).run(JSON.stringify(record));
  db.prepare(`INSERT INTO skill_workshop_proposal_rollbacks VALUES
    ('deploy-procedure-1', '2026-01-01T00:00:00.000Z', ?, ?, ?, ?, ?)`).run(
    skillFile,
    action,
    previousHash,
    action === "create" ? null : "# Before\n",
    JSON.stringify(supportFiles),
  );
  return setup;
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
  const { env, config, proposalsDir, mainExports, opsExports } = fixture();

  openOpenClawStateDatabase({ env }).db.exec(`
    ${RETIRED_TABLES}
    INSERT INTO skill_workshop_proposals VALUES
      ('pending-procedure-1', '{"draftFile":"${GENERATION}/PROPOSAL.md","supportFiles":[{"path":"references/notes.md"}]}', 'ops', 'pending'),
      ('quarantined-procedure-1', '{"draftFile":"PROPOSAL.md","origin":{"agentId":"main"}}', NULL, 'quarantined'),
      ('applied-procedure-1', '{"draftFile":"PROPOSAL.md"}', 'main', 'applied');
    INSERT INTO skill_workshop_proposal_events (proposal_id) VALUES ('pending-procedure-1');
    INSERT INTO skill_workshop_collection_reviews VALUES ('review', 'main', 1);
  `);
  writeFiles(proposalsDir, {
    [`pending-procedure-1/${GENERATION}/PROPOSAL.md`]: "# Pending\n",
    [`pending-procedure-1/${GENERATION}/references/notes.md`]: "notes\n",
    "quarantined-procedure-1/PROPOSAL.md": "# Quarantined\n",
    "applied-procedure-1/PROPOSAL.md": "# Applied\n",
    "legacy-procedure-1/proposal.json":
      '{"status":"pending","draftFile":"PROPOSAL.md","origin":{"sessionKey":"agent:main:main"}}',
    "legacy-procedure-1/PROPOSAL.md": "# Legacy\n",
  });
  // An earlier export is never overwritten.
  write(path.join(mainExports, "quarantined-procedure-1", "SKILL.md"), "# Kept export\n");

  await expect(retireSkillWorkshopProposals({ config, env })).resolves.toEqual({
    changes: [
      `Exported 1 pending Skill Workshop proposal draft to ${opsExports}${path.sep}; review them with /learn drafts.`,
      `Exported 1 pending Skill Workshop proposal draft to ${mainExports}${path.sep}; review them with /learn drafts.`,
      retiredTablesMessage,
      `Removed retired Skill Workshop proposal files from ${proposalsDir}.`,
    ],
    warnings: [],
  });

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

it("moves drafts an earlier Doctor exported under the archive into the drafts inbox", async () => {
  const { env, config, mainDir, mainExports } = fixture();
  const earlier = path.join(mainDir, "workshop-skills", ".archive", ".retired-proposals");
  write(path.join(earlier, "moved-procedure-1", "SKILL.md"), "# Earlier\n");
  write(path.join(earlier, "both-procedure-1", "SKILL.md"), "# Earlier copy\n");
  write(path.join(mainExports, "both-procedure-1", "SKILL.md"), "# Inbox\n");

  await expect(retireSkillWorkshopProposals({ config, env })).resolves.toEqual({
    changes: [
      `Moved 1 exported Skill Workshop proposal draft from ${earlier} to ${mainExports}; review them with /learn drafts.`,
    ],
    warnings: [
      `Kept Skill Workshop proposal export ${path.join(earlier, "both-procedure-1")}: a draft with the same id already exists in ${mainExports}. Compare the two, keep the one you want in ${mainExports}, and delete the other.`,
    ],
    warningDisposition: "recoverable",
  });
  expect(read(mainExports, "moved-procedure-1", "SKILL.md")).toBe("# Earlier\n");
  // An existing draft is never overwritten; the earlier copy stays where it was.
  expect(read(mainExports, "both-procedure-1", "SKILL.md")).toBe("# Inbox\n");
  expect(read(earlier, "both-procedure-1", "SKILL.md")).toBe("# Earlier copy\n");
});

it.each(["proposal", "rollback"])(
  "keeps malformed UTF-8 %s bytes out of workspace recovery",
  async (damaged) => {
    const { env, config, proposalsDir, skillDir, skillFile, opsExports } = fixture({
      workspace: true,
    });
    const bundle = path.join(proposalsDir, "deploy-procedure-1");
    const records = {
      proposal: {
        status: "pending",
        origin: { agentId: "ops" },
        target: { skillDir, skillFile },
        supportFiles: [{ path: "references/notes.md", hash: sha256Hex("proposed\n") }],
        note: "damaged",
      },
      rollback: {
        targetSkillFile: skillFile,
        previousContent: "before\n",
        supportFiles: [
          { path: "references/notes.md", existed: true, previousContent: "damaged\n" },
        ],
      },
    };
    writeFiles(bundle, {
      "PROPOSAL.md": "# Deploy\n",
      "proposal.json": JSON.stringify(records.proposal),
      "rollback.json": JSON.stringify(records.rollback),
    });
    const source = path.join(bundle, `${damaged}.json`);
    const bytes = fs.readFileSync(source);
    bytes[bytes.indexOf("damaged")] = 0xff;
    fs.writeFileSync(source, bytes);
    writeFiles(skillDir, { "SKILL.md": "before\n", "references/notes.md": "proposed\n" });

    const result = await retireSkillWorkshopProposals({ config, env });

    expect(result).toMatchObject({ changes: [], warningDisposition: "recoverable" });
    expect(result.warnings.join("\n")).toContain("must be valid UTF-8");
    expect(read(skillFile)).toBe("before\n");
    expect(read(skillDir, "references/notes.md")).toBe("proposed\n");
    expect(fs.readFileSync(source)).toEqual(bytes);
    expect(fs.existsSync(opsExports)).toBe(false);
  },
);

it("keeps legacy bundles without a provable owner, record, or draft until every bundle is exported", async () => {
  const { env, config, proposalsDir, opsWorkspace, opsExports } = fixture({ workspace: true });
  const bundle = (id: string, record?: object) => {
    write(path.join(proposalsDir, id, "PROPOSAL.md"), `# ${id}\n`);
    if (record) {
      write(path.join(proposalsDir, id, "proposal.json"), JSON.stringify(record));
    }
  };
  bundle("workspace-procedure-1", {
    status: "pending",
    target: { skillDir: path.join(opsWorkspace, "skills", "deploy") },
  });
  bundle("unowned-procedure-1", { status: "quarantined" });
  bundle("orphan-procedure-1");
  writeFiles(path.join(proposalsDir, "draftless-procedure-1"), {
    "proposal.json":
      '{"status":"pending","origin":{"agentId":"ops"},"supportFiles":[{"path":"references/notes.md"}]}',
    "references/notes.md": "notes\n",
  });

  const first = await retireSkillWorkshopProposals({ config, env });
  expect(first.changes).toEqual([
    `Exported 1 pending Skill Workshop proposal draft to ${opsExports}${path.sep}; review them with /learn drafts.`,
  ]);
  expect(first.warningDisposition).toBe("recoverable");
  expect(first.warnings.toSorted()).toEqual([
    expect.stringMatching(/^No configured agent owns Skill Workshop proposal unowned-procedure-1;/),
    expect.stringMatching(/^Skill Workshop proposal draftless-procedure-1 has no draft; kept /),
    expect.stringMatching(/^Skill Workshop proposal orphan-procedure-1 has no record;/),
  ]);
  expect(read(opsExports, "workspace-procedure-1", "SKILL.md")).toBe("# workspace-procedure-1\n");
  expect(fs.readdirSync(proposalsDir).toSorted()).toEqual([
    "draftless-procedure-1",
    "orphan-procedure-1",
    "unowned-procedure-1",
    "workspace-procedure-1",
  ]);

  // After the operator resolves the flagged bundles, the legacy tree is retired.
  for (const id of ["draftless-procedure-1", "orphan-procedure-1", "unowned-procedure-1"]) {
    fs.rmSync(path.join(proposalsDir, id), { recursive: true });
  }
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
  expect(fs.existsSync(path.join(mainDir, "workshop-skills", ".drafts"))).toBe(false);
  expect(fs.readFileSync(path.join(proposalDir, "PROPOSAL.md"), "utf8")).toBe("# Unowned\n");
  expect(retiredTableNames(env)).not.toEqual([]);

  // Once the operator has copied the draft and removed its directory, nothing is left to keep.
  fs.rmSync(proposalDir, { recursive: true });
  const second = await retireSkillWorkshopProposals({ config, env });
  expect(second.changes).toContain("Retired the Skill Workshop proposal tables.");
  expect(retiredTableNames(env)).toEqual([]);
});

it.each<"update" | "create">(["update", "create"])(
  "undoes a %s stopped before SKILL.md",
  async (action) => {
    const updating = action === "update";
    const files: Parameters<typeof rollbackFixture>[0] = updating
      ? [
          ["references/replaced.md", "new replaced\n", "old replaced\n"],
          ["references/added.md", "new added\n", null],
        ]
      : [["references/notes.md", "proposed\n", null]];
    const { env, config, proposalsDir, skillDir, skillFile } = rollbackFixture(
      files,
      action,
      updating ? sha256Hex("# Before\n") : null,
      updating ? "PROPOSAL.md" : undefined,
    );
    const proposed = Object.fromEntries(files.map(([file, content]) => [file, content]));
    if (updating) {
      writeFiles(path.join(proposalsDir, "deploy-procedure-1"), {
        "PROPOSAL.md": "# Draft\n",
        ...proposed,
      });
      write(skillFile, "# Before\n");
    }
    // The apply wrote support files, then stopped before its last write, SKILL.md.
    writeFiles(skillDir, proposed);

    const result = await retireSkillWorkshopProposals({ config, env });
    expect(result.changes).toContain(retiredTablesMessage);
    expect(retiredTableNames(env)).toEqual([]);
    if (updating) {
      expect(result.warnings).toEqual([]);
      expect(result.changes).toContain(
        `Restored ${skillDir} from the unfinished apply of Skill Workshop proposal deploy-procedure-1.`,
      );
      expect([read(skillFile), read(skillDir, "references", "replaced.md")]).toEqual([
        "# Before\n",
        "old replaced\n",
      ]);
      expect(fs.existsSync(path.join(skillDir, "references", "added.md"))).toBe(false);
    } else {
      expect(fs.existsSync(skillDir)).toBe(false);
    }
  },
);

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
  {
    state: "the apply finished before its status commit",
    live: { skill: "# Proposed\n", support: "proposed\n" },
    cause: undefined,
  },
])("preserves live files when $state", async ({ live, cause }) => {
  const { env, config, skillDir, skillFile } = rollbackFixture([
    ["references/notes.md", "proposed\n", "before\n"],
  ]);
  const supportFile = path.join(skillDir, "references", "notes.md");
  writeFiles(skillDir, { "SKILL.md": live.skill, "references/notes.md": live.support });
  const result = await retireSkillWorkshopProposals({ config, env });

  if (cause) {
    expect(result).toMatchObject({ changes: [], warningDisposition: "recoverable" });
    expect(result.warnings).toContainEqual(
      expect.stringContaining(
        `Could not undo the unfinished apply of Skill Workshop proposal deploy-procedure-1 in ${skillDir}: Error: ${cause(supportFile)}.`,
      ),
    );
  } else {
    expect(result.warnings).toEqual([
      "Skill Workshop proposal deploy-procedure-1 has no draft left to export; retired its record.",
    ]);
    expect(result.changes).toContain(retiredTablesMessage);
  }
  expect([read(skillFile), read(supportFile)]).toEqual([live.skill, live.support]);
  expect(retiredTableNames(env).length > 0).toBe(Boolean(cause));
});
