// Research autocapture tests cover capture policy, persistence, and config gating.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSessionEntry, upsertSessionEntry } from "../../config/sessions/session-accessor.js";
import { consumeSessionSkillSuggestion } from "../../config/sessions/skill-suggestions.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import {
  applySkillProposal,
  inspectSkillProposal,
  listSkillProposals,
} from "../workshop/service.js";
import { runSkillResearchAutoCapture } from "./autocapture.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;
const SESSION_KEY = "agent:main:main";

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-skill-workshop-state-",
  });
});

afterEach(async () => {
  await testState.cleanup();
  await tempDirs.cleanup();
});

async function makeWorkspace(): Promise<string> {
  return await tempDirs.make("openclaw-skill-workshop-");
}

async function seedSession(sessionKey = SESSION_KEY): Promise<void> {
  await upsertSessionEntry(
    { agentId: "main", sessionKey },
    { sessionId: `session-${sessionKey}`, updatedAt: 1 },
  );
}

function readSession(sessionKey = SESSION_KEY) {
  return loadSessionEntry({ agentId: "main", sessionKey, readConsistency: "latest" });
}

describe("skill research auto-capture", () => {
  it("queues a pending proposal from durable user correction", async () => {
    const workspaceDir = await makeWorkspace();
    await seedSession();

    await runSkillResearchAutoCapture({
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
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
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
    const proposal = await inspectSkillProposal(proposals.proposals[0].id, { workspaceDir });
    expect(proposal?.content).toContain("status: proposal");
    expect(proposal?.content).toContain("always check CI before final response");
    expect(readSession()?.pendingSkillSuggestion).toBeUndefined();
  });

  it("records and one-shot consumes a suggestion with default config", async () => {
    const workspaceDir = await makeWorkspace();
    await seedSession();

    await runSkillResearchAutoCapture({
      event: {
        success: true,
        messages: [
          {
            role: "user",
            content: "Remember to always verify generated screenshots before replying.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
    });

    expect((await listSkillProposals({ workspaceDir })).proposals).toHaveLength(0);
    expect(readSession()?.pendingSkillSuggestion).toMatchObject({
      skillName: "screenshot-asset-workflow",
    });

    const first = await consumeSessionSkillSuggestion({
      agentId: "main",
      sessionKey: SESSION_KEY,
    });
    expect(first?.suggestion).toMatchObject({ skillName: "screenshot-asset-workflow" });
    expect(readSession()?.pendingSkillSuggestion).toBeUndefined();

    const second = await consumeSessionSkillSuggestion({
      agentId: "main",
      sessionKey: SESSION_KEY,
    });
    expect(second?.suggestion).toBeUndefined();

    await runSkillResearchAutoCapture({
      event: {
        success: true,
        messages: [
          {
            role: "user",
            content: "Remember to always verify generated screenshots before replying.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
    });
    expect(readSession()?.pendingSkillSuggestion).toBeUndefined();
  });

  it("does not record a suggestion when no durable signal is present", async () => {
    const workspaceDir = await makeWorkspace();
    await seedSession();

    await runSkillResearchAutoCapture({
      event: {
        success: true,
        messages: [{ role: "user", content: "Please review this pull request." }],
      },
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
    });

    expect(readSession()?.pendingSkillSuggestion).toBeUndefined();
  });

  it("does not record a suggestion after a failed turn", async () => {
    const workspaceDir = await makeWorkspace();
    await seedSession();

    await runSkillResearchAutoCapture({
      event: {
        success: false,
        messages: [
          {
            role: "user",
            content: "Remember to always verify generated screenshots before replying.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
    });

    expect(readSession()?.pendingSkillSuggestion).toBeUndefined();
  });

  it("does not record a suggestion while a matching proposal is pending", async () => {
    const workspaceDir = await makeWorkspace();
    await seedSession();
    const event = {
      success: true,
      messages: [
        {
          role: "user",
          content:
            "From now on, when working on GitHub PRs, always check CI before final response.",
        },
      ],
    };

    await runSkillResearchAutoCapture({
      event,
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
      config: { skills: { workshop: { autonomous: { enabled: true } } } },
    });
    await runSkillResearchAutoCapture({
      event,
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
    });

    expect((await listSkillProposals({ workspaceDir })).proposals).toHaveLength(1);
    expect(readSession()?.pendingSkillSuggestion).toBeUndefined();
  });

  it.each([
    {
      name: "subagent helper session",
      ctx: { sessionKey: "agent:main:subagent:worker" },
    },
    {
      name: "cron automation session",
      ctx: { trigger: "cron", sessionKey: "agent:main:cron:daily:run:run-1" },
    },
    {
      name: "heartbeat automation session",
      ctx: { trigger: "heartbeat", sessionKey: "agent:main:main" },
    },
    {
      name: "hook-scoped session",
      ctx: { sessionKey: "hook:gmail:message-1" },
    },
    {
      name: "Active Memory trigger",
      ctx: { trigger: "memory", sessionKey: "explicit:user-session:active-memory:abc123" },
    },
    {
      name: "Active Memory helper session with main suffix",
      ctx: { trigger: "manual", sessionKey: "agent:main:main:active-memory:abc123" },
    },
    {
      name: "Active Memory helper session without main suffix",
      ctx: { trigger: "manual", sessionKey: "agent:main:active-memory:abc123" },
    },
    {
      name: "Active Memory recall helper session",
      ctx: { trigger: "manual", sessionKey: "active-memory-recall-87504" },
    },
  ])("skips $name before queuing proposals", async ({ ctx }) => {
    const workspaceDir = await makeWorkspace();
    const sessionKey = ctx.sessionKey ?? SESSION_KEY;
    await seedSession(sessionKey);

    await runSkillResearchAutoCapture({
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
      ctx: { workspaceDir, agentId: "main", ...ctx },
    });

    expect((await listSkillProposals({ workspaceDir })).proposals).toHaveLength(0);
    expect(readSession(sessionKey)?.pendingSkillSuggestion).toBeUndefined();
  });

  it("preserves existing skill content when auto-capturing an update", async () => {
    const workspaceDir = await makeWorkspace();
    await seedSession();
    const skillFile = path.join(workspaceDir, "skills", "github-pr-workflow", "SKILL.md");
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.writeFile(
      skillFile,
      [
        "---",
        'name: "github-pr-workflow"',
        'description: "Existing GitHub PR workflow."',
        "---",
        "",
        "# GitHub PR Workflow",
        "",
        "- Preserve this original review checklist.",
        "",
      ].join("\n"),
      "utf8",
    );

    await runSkillResearchAutoCapture({
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
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
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
      kind: "update",
      status: "pending",
      skillKey: "github-pr-workflow",
    });

    await applySkillProposal({ workspaceDir, proposalId: proposals.proposals[0].id });
    const updatedSkill = await fs.readFile(skillFile, "utf8");
    expect(updatedSkill).toContain("Preserve this original review checklist.");
    expect(updatedSkill).toContain("always check CI before final response");

    await runSkillResearchAutoCapture({
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
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
    });
    expect(readSession()?.pendingSkillSuggestion).toBeUndefined();
  });
});
