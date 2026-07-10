// End-to-end skill evolution loop: agent-end capture -> pending proposal -> approval -> next-run loading.
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { awaitAgentEndSideEffects } from "../../agents/harness/agent-end-side-effects.js";
import { upsertSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { loadWorkspaceSkillEntries, resolveSkillsPromptForRun } from "../loading/workspace.js";
import { applySkillProposal, listSkillProposals } from "../workshop/service.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;
const SESSION_KEY = "agent:main:main";

const config: OpenClawConfig = {
  skills: {
    workshop: {
      autonomous: {
        enabled: true,
      },
    },
  },
};

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-skill-evolution-loop-",
  });
  await upsertSessionEntry(
    { agentId: "main", sessionKey: SESSION_KEY },
    { sessionId: `session-${SESSION_KEY}`, updatedAt: 1 },
  );
});

afterEach(async () => {
  await testState.cleanup();
  await tempDirs.cleanup();
});

describe("runtime skill evolution loop", () => {
  it("turns a run correction into an approved skill the next run loads", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-evolution-loop-ws-");

    // 1. A real agent run ends with a durable user correction.
    await awaitAgentEndSideEffects({
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
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY, config },
    });

    // 2. The loop queued a pending proposal without touching any active SKILL.md.
    const proposals = await listSkillProposals({ workspaceDir });
    expect(proposals.proposals).toHaveLength(1);
    const proposal = proposals.proposals[0];
    expect(proposal).toMatchObject({ kind: "create", status: "pending" });
    expect(loadWorkspaceSkillEntries(workspaceDir, { workspaceOnly: true })).toHaveLength(0);

    // 3. Operator approval applies the proposal through the Skill Workshop.
    const applied = await applySkillProposal({ workspaceDir, proposalId: proposal.id });
    await expect(fs.readFile(applied.targetSkillFile, "utf8")).resolves.toContain(
      "always check CI before final response",
    );

    // 4. The next run's skill loading and prompt see the learned skill.
    const entries = loadWorkspaceSkillEntries(workspaceDir, { workspaceOnly: true });
    expect(entries.map((entry) => entry.skill.name)).toContain(proposal.skillKey);
    const prompt = resolveSkillsPromptForRun({ workspaceDir, entries, agentId: "main" });
    expect(prompt).toContain(proposal.skillKey);
  });

  it("keeps the proposal pending and unloaded without approval", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-evolution-loop-ws-");

    await awaitAgentEndSideEffects({
      event: {
        success: true,
        messages: [
          {
            role: "user",
            content: "From now on, when deploying services, always snapshot the config first.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY, config },
    });

    const proposals = await listSkillProposals({ workspaceDir });
    expect(proposals.proposals).toHaveLength(1);
    expect(proposals.proposals[0]?.status).toBe("pending");
    expect(loadWorkspaceSkillEntries(workspaceDir, { workspaceOnly: true })).toHaveLength(0);
  });
});
