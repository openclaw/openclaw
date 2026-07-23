import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { resetSkillsRefreshStateForTest } from "../runtime/refresh-state.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { applySkillProposal, proposeUpdateSkill } from "./service.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;
let stateDir = "";

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-apply-body-validation-",
  });
  stateDir = testState.stateDir;
});

afterEach(async () => {
  await testState.cleanup();
  resetSkillsRefreshStateForTest();
  await tempDirs.cleanup();
});

async function makeWorkspace(): Promise<string> {
  return await tempDirs.make("openclaw-apply-body-validation-");
}

describe("skill workshop apply-body validation", () => {
  it("gates low-continuity updates with an explicit-approval error and rejects empty bodies", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = path.join(workspaceDir, "skills", "weather");
    await writeSkill({
      dir: skillDir,
      name: "weather",
      description: "Weather skill",
      body: "# Weather\n\nSteps to check weather.\n",
    });

    const rewrite = await proposeUpdateSkill({
      workspaceDir,
      skillName: "weather",
      description: "Rewrite",
      content: "# Deployment\n\nDeploy steps.\n",
    });
    await expect(
      applySkillProposal({ workspaceDir, proposalId: rewrite.record.id }),
    ).rejects.toThrow("explicit approval");

    const plan = await proposeUpdateSkill({
      workspaceDir,
      skillName: "weather",
      description: "Plan",
      content: "## Changes\n\n- Update API\n",
    });
    await expect(applySkillProposal({ workspaceDir, proposalId: plan.record.id })).rejects.toThrow(
      "explicit approval",
    );

    await expect(
      applySkillProposal({
        workspaceDir,
        proposalId: (
          await proposeUpdateSkill({
            workspaceDir,
            skillName: "weather",
            description: "Empty",
            content: "   ",
          })
        ).record.id,
      }),
    ).rejects.toThrow("empty");
  });

  it("gates incidental-overlap plans that share only a heading or few non-heading lines", async () => {
    const workspaceDir = await makeWorkspace();

    const d1 = path.join(workspaceDir, "skills", "inc1");
    await writeSkill({
      dir: d1,
      name: "inc1",
      description: "Inc1",
      body: "# Weather\n\nSteps to check weather.\nCheck the forecast.\nSave the result.\n",
    });
    const headingOnly = await proposeUpdateSkill({
      workspaceDir,
      skillName: "inc1",
      description: "Plan sharing heading only",
      content:
        "# Weather\n\n## Proposed Changes\n\n- Update API\n- Add error handling\n\n## Files to Touch\n\n- SKILL.md\n",
    });
    await expect(
      applySkillProposal({ workspaceDir, proposalId: headingOnly.record.id }),
    ).rejects.toThrow("explicit approval");

    const d2 = path.join(workspaceDir, "skills", "inc2");
    await writeSkill({
      dir: d2,
      name: "inc2",
      description: "Inc2",
      body: "# Weather\n\nSteps to check weather.\nCheck the forecast.\nSave the result.\n",
    });
    const oneLineOverlap = await proposeUpdateSkill({
      workspaceDir,
      skillName: "inc2",
      description: "Plan sharing one body line",
      content:
        "# Weather\n\nSteps to check weather.\n\n## Proposed Changes\n\n- Update API\n- Add error handling\n\n## Files to Touch\n\n- SKILL.md\n",
    });
    await expect(
      applySkillProposal({ workspaceDir, proposalId: oneLineOverlap.record.id }),
    ).rejects.toThrow("explicit approval");

    const d3 = path.join(workspaceDir, "skills", "inc3");
    await writeSkill({
      dir: d3,
      name: "inc3",
      description: "Inc3",
      body: "# Weather\n\nSteps to check weather.\nCheck the forecast.\nSave the result.\n",
    });
    const twoLineOverlap = await proposeUpdateSkill({
      workspaceDir,
      skillName: "inc3",
      description: "Plan sharing two body lines",
      content:
        "# Weather\n\nSteps to check weather.\nCheck the forecast.\n\n## Proposed Changes\n\n- Update API\n",
    });
    await expect(
      applySkillProposal({ workspaceDir, proposalId: twoLineOverlap.record.id }),
    ).rejects.toThrow("explicit approval");
  });

  it("applies headingless and substantially continuous updates without requiresExplicitApproval", async () => {
    const workspaceDir = await makeWorkspace();

    const hlDir = path.join(workspaceDir, "skills", "hl");
    await writeSkill({
      dir: hlDir,
      name: "hl",
      description: "HL",
      body: "Use the image_generate tool.\nSave the result to disk.\nCheck the size.\nCompress if needed.\n",
    });
    const hl = await proposeUpdateSkill({
      workspaceDir,
      skillName: "hl",
      content:
        "Use the image_generate tool.\nSave the result to disk.\nCheck the size.\nCompress if needed.\nThen notify the user.\n",
    });
    expect(
      (await applySkillProposal({ workspaceDir, proposalId: hl.record.id }))
        .requiresExplicitApproval,
    ).toBeFalsy();

    const wDir = path.join(workspaceDir, "skills", "w");
    await writeSkill({
      dir: wDir,
      name: "w",
      description: "W",
      body: "# W\n\nStep one.\nStep two.\nStep three.\nStep four.\nStep five.\nStep six.\n",
    });
    const overlap = await proposeUpdateSkill({
      workspaceDir,
      skillName: "w",
      content: "# W\n\nStep one.\nStep two.\nStep three.\nStep four.\nUpdated step five.\n",
    });
    const result = await applySkillProposal({ workspaceDir, proposalId: overlap.record.id });
    expect(result.requiresExplicitApproval).toBeFalsy();
    expect(result.changeSummary).toBeDefined();
    const rollback = JSON.parse(
      await fs.readFile(
        path.join(stateDir, "skill-workshop", "proposals", overlap.record.id, "rollback.json"),
        "utf8",
      ),
    ) as { previousContent?: string };
    expect(rollback.previousContent).toContain("Step one.");
  });

  it("applies low-continuity update when explicit approval is granted", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = path.join(workspaceDir, "skills", "weatherexplicit");
    await writeSkill({
      dir: skillDir,
      name: "weatherexplicit",
      description: "Weather skill explicit",
      body: "# Weather\n\nSteps to check weather.\nCheck the forecast.\nSave the result.\n",
    });

    const rewrite = await proposeUpdateSkill({
      workspaceDir,
      skillName: "weatherexplicit",
      description: "Rewrite",
      content: "# Rewrite\n\nNew step A.\nNew step B.\n",
    });
    const result = await applySkillProposal({
      workspaceDir,
      proposalId: rewrite.record.id,
      explicitApprovalGranted: true,
    });
    expect(result.requiresExplicitApproval).toBe(true);
    expect(result.changeSummary).toBeDefined();
    const updatedFile = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    expect(updatedFile).toContain("New step A.");
  });
});
