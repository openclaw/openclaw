import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { runSkillWorkshopAutoCapture } from "./autocapture.js";
import { inspectSkillProposal, listSkillProposals } from "./service.js";

const tempDirs = createTrackedTempDirs();
let envSnapshot: ReturnType<typeof captureEnv>;

beforeEach(async () => {
  envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  process.env.OPENCLAW_STATE_DIR = await tempDirs.make("openclaw-skill-workshop-state-");
});

afterEach(async () => {
  envSnapshot.restore();
  await tempDirs.cleanup();
});

async function makeWorkspace(): Promise<string> {
  return await tempDirs.make("openclaw-skill-workshop-");
}

describe("skill workshop auto-capture", () => {
  it("queues a pending proposal from durable user correction", async () => {
    const workspaceDir = await makeWorkspace();

    await runSkillWorkshopAutoCapture({
      event: {
        success: true,
        messages: [
          {
            role: "user",
            content:
              "From now on, when working on GitHub PRs, always check CI before final response.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main" },
      config: {
        skills: {
          workshop: {
            autonomous: {
              enabled: true,
            },
          },
        },
      },
    });

    const proposals = await listSkillProposals({ workspaceDir });
    expect(proposals.proposals).toHaveLength(1);
    expect(proposals.proposals[0]).toMatchObject({
      kind: "create",
      status: "pending",
      skillKey: "github-pr-workflow",
      scanState: "clean",
    });
    const proposal = await inspectSkillProposal(proposals.proposals[0]!.id, { workspaceDir });
    expect(proposal?.content).toContain("status: proposal");
    expect(proposal?.content).toContain("always check CI before final response");
  });

  it("stays inert when auto-capture is disabled", async () => {
    const workspaceDir = await makeWorkspace();

    await runSkillWorkshopAutoCapture({
      event: {
        success: true,
        messages: [
          {
            role: "user",
            content: "Remember to always verify generated screenshots before replying.",
          },
        ],
      },
      ctx: { workspaceDir },
      config: {
        skills: {
          workshop: {
            autonomous: {
              enabled: false,
            },
          },
        },
      },
    });

    expect((await listSkillProposals({ workspaceDir })).proposals).toHaveLength(0);
  });
});
