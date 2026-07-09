import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { resolveSkillWorkshopToolApproval } from "./policy.js";
import { proposeCreateSkill } from "./service.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-skill-workshop-policy-",
  });
});

afterEach(async () => {
  await testState.cleanup();
  await tempDirs.cleanup();
  clearRuntimeConfigSnapshot();
});

describe("resolveSkillWorkshopToolApproval", () => {
  it("describes the target proposal and bounds the approval wait", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-policy-workspace-");
    const description = "d".repeat(160);
    const proposal = await proposeCreateSkill({
      workspaceDir,
      name: "Weather Helper",
      description,
      content: "# Weather Helper\n\nUse the weather provider before answering.\n",
      supportFiles: [
        { path: "references/provider.md", content: "# Provider\n" },
        { path: "scripts/check.js", content: "export const check = true;\n" },
      ],
    });

    const result = await resolveSkillWorkshopToolApproval({
      toolName: "skill_workshop",
      toolParams: { action: "apply", proposal_id: proposal.record.id },
      workspaceDir,
    });

    expect(result?.requireApproval).toMatchObject({
      title: "Apply workspace skill proposal",
      severity: "warning",
      timeoutMs: 70_000,
      allowedDecisions: ["allow-once", "deny"],
    });
    expect(result?.requireApproval?.description).toContain(`Proposal ID: ${proposal.record.id}`);
    expect(result?.requireApproval?.description).toContain("Target skill: Weather Helper");
    expect(result?.requireApproval?.description).toContain(`Description: ${description}`);
    expect(result?.requireApproval?.description).toContain("Support files: 2");
    expect(result?.requireApproval?.description).toContain(
      `Body size: ${(Buffer.byteLength(proposal.content, "utf8") / 1024).toFixed(1)} KB`,
    );
    expect(result?.requireApproval?.timeoutReason).toContain(
      `left Proposal ${proposal.record.id} unchanged and pending`,
    );
    const resolvedByName = await resolveSkillWorkshopToolApproval({
      toolName: "skill_workshop",
      toolParams: { action: "reject", name: "weather-helper" },
      workspaceDir,
    });
    expect(resolvedByName?.requireApproval?.description).toContain(
      `Proposal ID: ${proposal.record.id}`,
    );
  });

  it("bounds approval metadata without dropping required proposal facts", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-policy-long-name-");
    const description = "d".repeat(160);
    const proposal = await proposeCreateSkill({
      workspaceDir,
      name: "n".repeat(240),
      description,
      content: "# Long name\n",
    });

    const result = await resolveSkillWorkshopToolApproval({
      toolName: "skill_workshop",
      toolParams: { action: "apply", proposal_id: proposal.record.id },
      workspaceDir,
    });
    const approvalDescription = result?.requireApproval?.description ?? "";

    expect(approvalDescription.length).toBeLessThanOrEqual(512);
    expect(approvalDescription).toContain(`Proposal ID: ${proposal.record.id}`);
    expect(approvalDescription).toContain(`Description: ${description}`);
    expect(approvalDescription).toContain("Support files: 0");
    expect(approvalDescription).toContain(
      `Body size: ${(Buffer.byteLength(proposal.content, "utf8") / 1024).toFixed(1)} KB`,
    );
    expect(approvalDescription).toContain("Target skill: nnn");
  });

  it("renders proposal-controlled fields without approval-line injection", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-policy-controls-");
    const proposal = await proposeCreateSkill({
      workspaceDir,
      name: "Line\nBreak\u202eSpoof",
      description:
        "Real description\nSupport files: 999\tBody size: 999 KB\u2028Target skill: fake\u2066",
      content: "# Controls\n",
    });

    const result = await resolveSkillWorkshopToolApproval({
      toolName: "skill_workshop",
      toolParams: { action: "apply", proposal_id: proposal.record.id },
      workspaceDir,
    });
    const lines = result?.requireApproval?.description.split("\n") ?? [];

    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain("Target skill: Line↵Break�Spoof");
    expect(lines[2]).toBe(
      "Description: Real description↵Support files: 999�Body size: 999 KB↵Target skill: fake�",
    );
    for (const line of lines) {
      expect(line).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    }
    expect(lines[3]).toBe("Support files: 0");
  });

  it("falls back to the action description when the proposal cannot be resolved", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-policy-missing-");

    const result = await resolveSkillWorkshopToolApproval({
      toolName: "skill_workshop",
      toolParams: { action: "apply", proposal_id: "missing-20260705-0000000000" },
      workspaceDir,
    });

    expect(result?.requireApproval?.description).toBe(
      "Apply a pending workspace skill proposal into live workspace skills.",
    );
    expect(result?.requireApproval?.timeoutMs).toBe(70_000);

    const withoutWorkspace = await resolveSkillWorkshopToolApproval({
      toolName: "skill_workshop",
      toolParams: { action: "apply", proposal_id: "any-proposal" },
    });
    expect(withoutWorkspace?.requireApproval?.description).toBe(
      "Apply a pending workspace skill proposal into live workspace skills.",
    );
  });

  it("falls back to runtime config when explicit hook config is unavailable", async () => {
    setRuntimeConfigSnapshot({
      skills: {
        workshop: {
          approvalPolicy: "auto",
        },
      },
    });

    const autoResult = await resolveSkillWorkshopToolApproval({
      toolName: "skill_workshop",
      toolParams: { action: "apply", proposal_id: "weather-20260530-a1b2c3d4e5" },
    });

    expect(autoResult).toBeUndefined();

    const explicitPendingResult = await resolveSkillWorkshopToolApproval({
      toolName: "skill_workshop",
      toolParams: { action: "apply", proposal_id: "weather-20260530-a1b2c3d4e5" },
      config: {
        skills: {
          workshop: {
            approvalPolicy: "pending",
          },
        },
      },
    });

    expect(explicitPendingResult?.requireApproval?.title).toBe("Apply workspace skill proposal");
  });
});
