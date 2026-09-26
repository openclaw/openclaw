// Workshop apply-body validation rejects malformed proposal bodies before any
// workspace mutation or rollback recording. Structural validation only — does
// not restrict Markdown heading vocabulary (the skill loader accepts free-form
// Markdown after valid frontmatter).
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawStateDatabaseByPath } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { resetSkillsRefreshStateForTest } from "../runtime/refresh-state.js";
import {
  applySkillProposal as applySkillProposalImpl,
  listSkillProposals as listSkillProposalsImpl,
  proposeCreateSkill as proposeCreateSkillImpl,
  proposeUpdateSkill as proposeUpdateSkillImpl,
} from "./service.js";
import { readSkillProposalRollback } from "./store-sqlite-rollback.js";

const tempDirs = createTrackedTempDirs();
const stateDirs = createTrackedTempDirs();
let testEnv: NodeJS.ProcessEnv;
let stateDir = "";
const workshopConfig: OpenClawConfig = {};

type OptionalWorkshopOwner<T> = Omit<T, "config" | "agentId"> & {
  config?: OpenClawConfig;
  agentId?: string;
};

function withWorkshopOwner<T extends { config?: OpenClawConfig; agentId?: string }>(input: T) {
  return {
    ...input,
    config: input.config ?? workshopConfig,
    agentId: input.agentId ?? "main",
  };
}

const applySkillProposal = (
  input: OptionalWorkshopOwner<Parameters<typeof applySkillProposalImpl>[0]>,
) => applySkillProposalImpl(withWorkshopOwner(input));
const listSkillProposals = (input?: Partial<Parameters<typeof listSkillProposalsImpl>[0]>) =>
  listSkillProposalsImpl(withWorkshopOwner(input ?? {}));
const proposeCreateSkill = (
  input: OptionalWorkshopOwner<Parameters<typeof proposeCreateSkillImpl>[0]>,
) => proposeCreateSkillImpl(withWorkshopOwner(input));
const proposeUpdateSkill = (
  input: OptionalWorkshopOwner<Parameters<typeof proposeUpdateSkillImpl>[0]>,
) => proposeUpdateSkillImpl(withWorkshopOwner(input));

beforeAll(async () => {
  stateDir = await stateDirs.make("openclaw-apply-body-validation-state-");
  testEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_AGENT_DIR: undefined,
  };
  await listSkillProposals({ env: testEnv });
});

beforeEach(async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  vi.stubEnv("OPENCLAW_AGENT_DIR", undefined);
  const database = openOpenClawStateDatabase({ env: testEnv });
  database.db.exec(`
    DELETE FROM skill_workshop_proposal_events;
    DELETE FROM skill_workshop_proposal_rollbacks;
    DELETE FROM skill_workshop_proposals;
  `);
  await fs.rm(path.join(stateDir, "skill-workshop"), { recursive: true, force: true });
  await fs.rm(path.join(stateDir, "agents"), { recursive: true, force: true });
});

afterEach(async () => {
  resetSkillsRefreshStateForTest();
  await tempDirs.cleanup();
});

afterAll(async () => {
  closeOpenClawStateDatabaseByPath(resolveOpenClawStateSqlitePath(testEnv));
  vi.unstubAllEnvs();
  await stateDirs.cleanup();
});

async function makeWorkspace(): Promise<string> {
  return await tempDirs.make("openclaw-apply-body-validation-");
}

async function createOwnedSkill(params: {
  workspaceDir: string;
  name: string;
  description: string;
  body: string;
}): Promise<string> {
  const proposal = await proposeCreateSkill({
    workspaceDir: params.workspaceDir,
    env: testEnv,
    name: params.name,
    description: params.description,
    content: params.body,
  });
  await applySkillProposal({
    workspaceDir: params.workspaceDir,
    env: testEnv,
    proposalId: proposal.record.id,
    expectedRevisionHash: proposal.revisionHash,
  });
  return proposal.record.target.skillDir;
}

const operatorActor = { type: "gateway" as const };

describe("skill workshop apply-body validation", () => {
  it("rejects a proposal body that is empty after stripping and leaves no rollback state", async () => {
    const workspaceDir = await makeWorkspace();
    await createOwnedSkill({
      workspaceDir,
      name: "empty",
      description: "empty skill",
      body: "# Empty\n\nDo something.\n",
    });

    const proposal = await proposeUpdateSkill({
      workspaceDir,
      env: testEnv,
      skillName: "empty",
      description: "Empty body",
      content: "   \n  \n",
    });

    await expect(
      applySkillProposal({
        workspaceDir,
        env: testEnv,
        proposalId: proposal.record.id,
        eventActor: operatorActor,
      }),
    ).rejects.toThrow(/empty/i);
    await expect(readSkillProposalRollback(proposal.record.id)).resolves.toBeNull();
  });

  it("applies a valid complete replacement", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = await createOwnedSkill({
      workspaceDir,
      name: "weather",
      description: "weather skill",
      body: "# Weather\n\nCheck the forecast.\nSave the result.\n",
    });

    const proposal = await proposeUpdateSkill({
      workspaceDir,
      env: testEnv,
      skillName: "weather",
      description: "Refreshed weather skill",
      content: "# Weather\n\nCheck the forecast and alerts.\nSave the result.\nNotify the user.\n",
    });

    const applied = await applySkillProposal({
      workspaceDir,
      env: testEnv,
      proposalId: proposal.record.id,
      eventActor: operatorActor,
    });

    expect(applied.record.status).toBe("applied");
    const skillFile = path.join(skillDir, "SKILL.md");
    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("Notify the user.");
    const rollback = await readSkillProposalRollback(proposal.record.id);
    expect(rollback).not.toBeNull();
    expect(rollback?.previousContent).toContain("Check the forecast.");
  });

  it("applies a valid skill body with a Changes section", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = await createOwnedSkill({
      workspaceDir,
      name: "release",
      description: "release skill",
      body: "# Release\n\nTag the commit.\nPublish the package.\n",
    });

    const proposal = await proposeUpdateSkill({
      workspaceDir,
      env: testEnv,
      skillName: "release",
      description: "Release with changelog",
      content:
        "# Release\n\nTag the commit.\nPublish the package.\n\n## Changes\n\n- Updated dependency versions\n- Fixed login bug\n",
    });

    const applied = await applySkillProposal({
      workspaceDir,
      env: testEnv,
      proposalId: proposal.record.id,
      eventActor: operatorActor,
    });

    expect(applied.record.status).toBe("applied");
    const skillFile = path.join(skillDir, "SKILL.md");
    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("## Changes");
  });

  it("applies a valid skill body with a Plan section", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = await createOwnedSkill({
      workspaceDir,
      name: "deploy",
      description: "deploy skill",
      body: "# Deploy\n\nPush to production.\nVerify the release.\n",
    });

    const proposal = await proposeUpdateSkill({
      workspaceDir,
      env: testEnv,
      skillName: "deploy",
      description: "Deploy with plan section",
      content:
        "# Deploy\n\nPush to production.\nVerify the release.\n\n## Plan\n\n1. Build the image\n2. Tag the release\n3. Rollback on failure\n",
    });

    const applied = await applySkillProposal({
      workspaceDir,
      env: testEnv,
      proposalId: proposal.record.id,
      eventActor: operatorActor,
    });

    expect(applied.record.status).toBe("applied");
    const skillFile = path.join(skillDir, "SKILL.md");
    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("## Plan");
  });

  it("applies a valid skill body with a Diff section", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = await createOwnedSkill({
      workspaceDir,
      name: "config",
      description: "config skill",
      body: "# Config\n\nLoad settings.\nValidate values.\n",
    });

    const proposal = await proposeUpdateSkill({
      workspaceDir,
      env: testEnv,
      skillName: "config",
      description: "Config with diff section",
      content:
        "# Config\n\nLoad settings.\nValidate values.\n\n## Diff\n\n- Old: timeout=30\n- New: timeout=60\n",
    });

    const applied = await applySkillProposal({
      workspaceDir,
      env: testEnv,
      proposalId: proposal.record.id,
      eventActor: operatorActor,
    });

    expect(applied.record.status).toBe("applied");
    const skillFile = path.join(skillDir, "SKILL.md");
    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("## Diff");
  });

  it("applies a valid skill body with an Implementation Notes section", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = await createOwnedSkill({
      workspaceDir,
      name: "api",
      description: "api skill",
      body: "# API\n\nFetch data.\nParse the response.\n",
    });

    const proposal = await proposeUpdateSkill({
      workspaceDir,
      env: testEnv,
      skillName: "api",
      description: "API with implementation notes",
      content:
        "# API\n\nFetch data.\nParse the response.\n\n## Implementation Notes\n\n- Uses retry with exponential backoff\n- Caches responses for 5 minutes\n",
    });

    const applied = await applySkillProposal({
      workspaceDir,
      env: testEnv,
      proposalId: proposal.record.id,
      eventActor: operatorActor,
    });

    expect(applied.record.status).toBe("applied");
    const skillFile = path.join(skillDir, "SKILL.md");
    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("## Implementation Notes");
  });

  it("does not reject a valid skill body that mentions changes in prose", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = await createOwnedSkill({
      workspaceDir,
      name: "release",
      description: "release skill",
      body: "# Release\n\nTag the commit.\nPublish the package.\n",
    });

    const proposal = await proposeUpdateSkill({
      workspaceDir,
      env: testEnv,
      skillName: "release",
      description: "Release notes on changes",
      content:
        "# Release\n\nTag the commit.\nDocument the changes since the last release.\nPublish the package.\n",
    });

    const applied = await applySkillProposal({
      workspaceDir,
      env: testEnv,
      proposalId: proposal.record.id,
      eventActor: operatorActor,
    });

    expect(applied.record.status).toBe("applied");
    const skillFile = path.join(skillDir, "SKILL.md");
    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain(
      "Document the changes since the last release.",
    );
  });
});
