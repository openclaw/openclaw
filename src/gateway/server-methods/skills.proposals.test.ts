/**
 * Tests for skill proposal gateway methods and proposal lifecycle responses.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { callGatewayHandler } from "./skills.test-helpers.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;
let stateDir = "";

const mocks = vi.hoisted(() => ({
  chatSend: vi.fn(),
  workspaceDir: "",
  workspaceDirs: [] as string[],
  workspaceAgentIds: {} as Record<string, string>,
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
  resetConfigRuntimeState: () => undefined,
  writeConfigFile: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: () => ["main"],
  resolveDefaultAgentId: () => "main",
  resolveAgentWorkspaceDir: () => mocks.workspaceDir,
  resolveAgentIdByWorkspacePath: (_cfg: unknown, workspacePath: string) =>
    mocks.workspaceAgentIds[workspacePath],
}));

vi.mock("../../agents/workspace-dirs.js", () => ({
  listAgentWorkspaceDirs: () => mocks.workspaceDirs,
}));

vi.mock("../../skills/lifecycle/clawhub.js", () => ({
  installSkillFromClawHub: vi.fn(),
  readLocalSkillCardContentSync: vi.fn(),
  searchSkillsFromClawHub: vi.fn(),
  updateSkillsFromClawHub: vi.fn(),
}));

vi.mock("../../skills/lifecycle/install.js", () => ({
  installSkill: vi.fn(),
}));

vi.mock("../../skills/lifecycle/upload-install.js", () => ({
  installUploadedSkillArchive: vi.fn(),
}));

vi.mock("../../infra/clawhub.js", () => ({
  fetchClawHubSkillDetail: vi.fn(),
}));

vi.mock("../../skills/security/clawhub-verdicts.js", () => ({
  collectClawHubVerdictTargets: vi.fn(() => []),
  fetchOpenClawSkillSecurityVerdicts: vi.fn(),
}));

vi.mock("./chat.js", () => ({
  chatHandlers: {
    "chat.send": mocks.chatSend,
  },
}));

const { skillsHandlers } = await import("./skills.js");

function callHandler(method: string, params: Record<string, unknown>) {
  return callGatewayHandler(skillsHandlers, method, params);
}

describe("skills proposal gateway handlers", () => {
  beforeEach(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-skills-proposals-gateway-state-",
    });
    mocks.chatSend.mockReset();
    mocks.chatSend.mockImplementation(async ({ respond }) => {
      respond(true, { runId: "run-skill-workshop-revision", status: "started" }, undefined);
    });
    mocks.workspaceDir = await tempDirs.make("openclaw-skills-proposals-gateway-");
    mocks.workspaceAgentIds = {};
    stateDir = testState.stateDir;
  });

  afterEach(async () => {
    await testState.cleanup();
    await tempDirs.cleanup();
  });

  it("creates, lists, inspects, and applies a proposal", async () => {
    const create = await callHandler("skills.proposals.create", {
      name: "Weather Planner",
      description: "Plan around current weather",
      content: "# Weather Planner\n\nCheck weather before outdoor recommendations.\n",
      supportFiles: [
        {
          path: "references/weather.md",
          content: "Use current weather before recommendations.\n",
        },
      ],
    });
    expect(create.ok).toBe(true);
    const created = create.response as {
      record: { id: string; supportFiles?: Array<{ path: string }> };
    };
    expect(created.record.id).toMatch(/^weather-planner-/);
    expect(created.record.supportFiles?.[0]?.path).toBe("references/weather.md");

    const list = await callHandler("skills.proposals.list", {});
    expect(list.ok).toBe(true);
    expect((list.response as { proposals: Array<{ id: string }> }).proposals[0]?.id).toBe(
      created.record.id,
    );

    const inspect = await callHandler("skills.proposals.inspect", {
      proposalId: created.record.id,
    });
    expect(inspect.ok).toBe(true);
    expect((inspect.response as { content: string }).content).toContain("status: proposal");
    expect(
      (
        inspect.response as {
          supportFiles?: Array<{ path: string; content: string }>;
        }
      ).supportFiles,
    ).toEqual([
      {
        path: "references/weather.md",
        content: "Use current weather before recommendations.\n",
      },
    ]);

    const revise = await callHandler("skills.proposals.revise", {
      proposalId: created.record.id,
      description: "Plan with current weather",
      content: "# Weather Planner\n\nUse current weather and alerts.\n",
    });
    expect(revise.ok).toBe(true);
    expect(
      (revise.response as { record: { id: string; proposedVersion: string } }).record,
    ).toMatchObject({
      id: created.record.id,
      proposedVersion: "v2",
    });

    const apply = await callHandler("skills.proposals.apply", {
      proposalId: created.record.id,
    });
    expect(apply.ok).toBe(true);
    await expect(
      fs.readFile(path.join(mocks.workspaceDir, "skills", "weather-planner", "SKILL.md"), "utf8"),
    ).resolves.toContain("Use current weather and alerts.");
    await expect(
      fs.readFile(
        path.join(mocks.workspaceDir, "skills", "weather-planner", "references", "weather.md"),
        "utf8",
      ),
    ).resolves.toContain("Use current weather");
  });

  it("scopes list and inspect to the resolved agent workspace", async () => {
    const firstWorkspaceDir = mocks.workspaceDir;
    const first = await callHandler("skills.proposals.create", {
      name: "First Gateway Skill",
      description: "First workspace proposal",
      content: "# First\n",
    });
    expect(first.ok).toBe(true);
    const firstCreated = first.response as { record: { id: string } };

    const secondWorkspaceDir = await tempDirs.make("openclaw-skills-proposals-gateway-second-");
    mocks.workspaceDir = secondWorkspaceDir;
    const second = await callHandler("skills.proposals.create", {
      name: "Second Gateway Skill",
      description: "Second workspace proposal",
      content: "# Second\n",
    });
    expect(second.ok).toBe(true);
    const secondCreated = second.response as { record: { id: string } };

    const secondList = await callHandler("skills.proposals.list", {});
    expect(secondList.ok).toBe(true);
    expect((secondList.response as { proposals: Array<{ id: string }> }).proposals).toEqual([
      expect.objectContaining({ id: secondCreated.record.id }),
    ]);

    const hiddenInspect = await callHandler("skills.proposals.inspect", {
      proposalId: firstCreated.record.id,
    });
    expect(hiddenInspect.ok).toBe(false);
    expect((hiddenInspect.error as { message?: string }).message).toContain(
      `Skill proposal not found: ${firstCreated.record.id}`,
    );

    mocks.workspaceDir = firstWorkspaceDir;
    const firstList = await callHandler("skills.proposals.list", {});
    expect(firstList.ok).toBe(true);
    expect((firstList.response as { proposals: Array<{ id: string }> }).proposals).toEqual([
      expect.objectContaining({ id: firstCreated.record.id }),
    ]);
  });

  it("lists, inspects, and applies across workspaces in global scope", async () => {
    const firstWorkspaceDir = mocks.workspaceDir;
    const first = await callHandler("skills.proposals.create", {
      name: "Global First Skill",
      description: "First global proposal",
      content: "# Global First\n",
    });
    expect(first.ok).toBe(true);
    const firstCreated = first.response as { record: { id: string } };

    const secondWorkspaceDir = await tempDirs.make("openclaw-skills-proposals-gateway-global-");
    mocks.workspaceDir = secondWorkspaceDir;
    const second = await callHandler("skills.proposals.create", {
      name: "Global Second Skill",
      description: "Second global proposal",
      content: "# Global Second\n",
    });
    expect(second.ok).toBe(true);
    const secondCreated = second.response as { record: { id: string } };

    // Both agent workspaces participate in global resolution.
    mocks.workspaceDirs = [firstWorkspaceDir, secondWorkspaceDir];

    // Agent scope only sees the currently resolved workspace...
    const agentScoped = await callHandler("skills.proposals.list", {});
    expect((agentScoped.response as { proposals: Array<{ id: string }> }).proposals).toEqual([
      expect.objectContaining({ id: secondCreated.record.id }),
    ]);

    // ...global scope spans every workspace.
    const globalList = await callHandler("skills.proposals.list", { scope: "global" });
    expect(globalList.ok).toBe(true);
    const globalIds = (globalList.response as { proposals: Array<{ id: string }> }).proposals
      .map((proposal) => proposal.id)
      .toSorted();
    expect(globalIds).toEqual([firstCreated.record.id, secondCreated.record.id].toSorted());

    // A proposal hidden from the resolved agent workspace is still inspectable in global scope.
    const globalInspect = await callHandler("skills.proposals.inspect", {
      scope: "global",
      proposalId: firstCreated.record.id,
    });
    expect(globalInspect.ok).toBe(true);
    expect((globalInspect.response as { record: { id: string } }).record.id).toBe(
      firstCreated.record.id,
    );

    // Applying in global scope writes into the proposal's own workspace, not the resolved one.
    const globalApply = await callHandler("skills.proposals.apply", {
      scope: "global",
      proposalId: firstCreated.record.id,
    });
    expect(globalApply.ok).toBe(true);
    await expect(
      fs.readFile(path.join(firstWorkspaceDir, "skills", "global-first-skill", "SKILL.md"), "utf8"),
    ).resolves.toContain("Global First");

    mocks.workspaceDir = firstWorkspaceDir;
  });

  it("fails fast when a global-scope action cannot resolve an owning workspace", async () => {
    // Only the resolved agent workspace participates; an unknown proposal id
    // maps to no owning workspace, so a global-scope action must error rather
    // than silently target the resolved (default) workspace.
    mocks.workspaceDirs = [mocks.workspaceDir];
    const apply = await callHandler("skills.proposals.apply", {
      scope: "global",
      proposalId: "missing-proposal-id",
    });
    expect(apply.ok).toBe(false);
    expect((apply.error as { code?: string }).code).toBe("INVALID_REQUEST");
  });

  it("rejects invalid params before touching workshop state", async () => {
    const result = await callHandler("skills.proposals.create", {
      name: "Missing Content",
      description: "No content",
    });
    expect(result.ok).toBe(false);
    expect((result.error as { code?: string }).code).toBe("INVALID_REQUEST");
    await expect(fs.access(path.join(stateDir, "skill-workshop"))).rejects.toThrow();
  });

  it("starts revision chat turns with visible instructions and server-built context", async () => {
    const create = await callHandler("skills.proposals.create", {
      name: "Support File Sampler",
      description: "Samples support files",
      content: "# Support File Sampler\n\nSample support files.\n",
    });
    expect(create.ok).toBe(true);
    const created = create.response as { record: { id: string } };

    const result = await callHandler("skills.proposals.requestRevision", {
      proposalId: created.record.id,
      instructions: "Make the support files 5",
      sessionKey: "agent:main:session:skill-workshop",
      targetAgentId: "revision-target",
      idempotencyKey: "revision-run-1",
    });

    expect(result).toMatchObject({
      ok: true,
      response: { runId: "run-skill-workshop-revision", status: "started" },
    });
    expect(mocks.chatSend).toHaveBeenCalledTimes(1);
    const forwarded = mocks.chatSend.mock.calls[0]?.[0] as {
      params?: Record<string, unknown>;
      req?: { method?: string; params?: Record<string, unknown> };
    };
    expect(forwarded.req?.method).toBe("chat.send");
    expect(forwarded.params).toMatchObject({
      agentId: "revision-target",
      deliver: false,
      idempotencyKey: "revision-run-1",
      message: "Make the support files 5",
      sessionKey: "agent:main:session:skill-workshop",
      suppressCommandInterpretation: true,
    });
    expect(String(forwarded.params?.systemProvenanceReceipt)).toContain(
      `Revise Skill Workshop proposal \`${created.record.id}\` (support-file-sampler).`,
    );
    expect(String(forwarded.params?.systemProvenanceReceipt)).toContain(
      "Use `skill_workshop` with `action=inspect` first, then `action=revise`",
    );
    expect(String(forwarded.params?.systemProvenanceReceipt)).not.toContain(
      "Make the support files 5",
    );
  });

  it("routes global-scope revisions to the proposal's owning workspace and agent", async () => {
    // A proposal created in a second agent workspace is invisible from the
    // default ("main") workspace. A global-scope revision must resolve the
    // owning workspace/agent from the proposal id and hand off to that agent,
    // instead of failing against (or routing to) the default workspace.
    const defaultWorkspaceDir = mocks.workspaceDir;
    const ownerWorkspaceDir = await tempDirs.make("openclaw-skills-proposals-gateway-owner-");
    mocks.workspaceDir = ownerWorkspaceDir;
    const create = await callHandler("skills.proposals.create", {
      name: "Owner Workspace Skill",
      description: "Lives in a non-default workspace",
      content: "# Owner Workspace Skill\n",
    });
    expect(create.ok).toBe(true);
    const created = create.response as { record: { id: string } };

    // Resolve back to the default workspace; only global scope can reach the
    // owner workspace, which maps to the "owner" agent.
    mocks.workspaceDir = defaultWorkspaceDir;
    mocks.workspaceDirs = [defaultWorkspaceDir, ownerWorkspaceDir];
    mocks.workspaceAgentIds = { [ownerWorkspaceDir]: "owner" };
    mocks.chatSend.mockClear();

    const result = await callHandler("skills.proposals.requestRevision", {
      scope: "global",
      proposalId: created.record.id,
      instructions: "Tighten the owner workspace skill",
      sessionKey: "agent:owner:session:skill-workshop",
      targetAgentId: "selected-chat-agent",
      idempotencyKey: "revision-run-global",
    });

    expect(result).toMatchObject({
      ok: true,
      response: { runId: "run-skill-workshop-revision", status: "started" },
    });
    expect(mocks.chatSend).toHaveBeenCalledTimes(1);
    const forwarded = mocks.chatSend.mock.calls[0]?.[0] as {
      params?: Record<string, unknown>;
    };
    // Global scope must ignore a selected-chat targetAgentId and target the
    // resolved owning agent ("owner"), not the default ("main") or selected chat agent.
    expect(forwarded.params).toMatchObject({
      agentId: "owner",
      sessionKey: "agent:owner:session:skill-workshop",
      idempotencyKey: "revision-run-global",
    });
    expect(String(forwarded.params?.systemProvenanceReceipt)).toContain(
      `Revise Skill Workshop proposal \`${created.record.id}\``,
    );

    mocks.workspaceDir = defaultWorkspaceDir;
  });

  it("does not start revision chat turns for non-pending proposals", async () => {
    const create = await callHandler("skills.proposals.create", {
      name: "Applied Sampler",
      description: "Already applied proposal",
      content: "# Applied Sampler\n\nSample support files.\n",
    });
    expect(create.ok).toBe(true);
    const created = create.response as { record: { id: string } };
    const apply = await callHandler("skills.proposals.apply", {
      proposalId: created.record.id,
    });
    expect(apply.ok).toBe(true);
    mocks.chatSend.mockClear();

    const result = await callHandler("skills.proposals.requestRevision", {
      proposalId: created.record.id,
      instructions: "Make the support files 5",
      sessionKey: "agent:main:session:skill-workshop",
      idempotencyKey: "revision-run-applied",
    });

    expect(result.ok).toBe(false);
    expect((result.error as { message?: string }).message).toContain(
      "Skill proposal is not pending",
    );
    expect(mocks.chatSend).not.toHaveBeenCalled();
  });
});
