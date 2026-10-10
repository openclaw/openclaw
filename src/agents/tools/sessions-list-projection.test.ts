import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { describeSessionLinkRule } from "../tool-description-presets.js";
import { createSessionsListTool } from "./sessions-list-tool.js";

const SESSION_LINK_BASE = "http://127.0.0.1:18789/control";
const SESSION_LINK_RULE = describeSessionLinkRule(SESSION_LINK_BASE);

const mocks = vi.hoisted(() => ({
  gatewayCall: vi.fn(),
  getSessionStateVersions: vi.fn(
    (_refs: Array<{ sessionKey: string; agentId: string }>) =>
      ({}) as Record<string, Record<string, number>>,
  ),
}));

vi.mock("./in-process-gateway.js", () => ({
  hasGatewayToolRoutingContext: () => false,
  getInProcessGatewayToolContext: () => undefined,
  callAgentToolGatewayRequest: (opts: unknown) => mocks.gatewayCall(opts),
}));

vi.mock("../../sessions/session-state-events.js", () => ({
  getSessionStateVersions: (refs: Array<{ sessionKey: string; agentId: string }>) =>
    mocks.getSessionStateVersions(refs),
}));

import { VALID_CONFIG, getSessionsListDetails } from "./sessions-list.test-support.js";

describe("sessions-list inventory projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionStateVersions.mockReturnValue({});
  });

  it("projects the public inventory contract without leaking private Gateway metadata", async () => {
    const metadata = {
      key: "agent:main:subagent:child",
      sessionId: "session-child",
      agentId: "main",
      channel: "discord",
      label: "worker",
      displayName: "Worker",
      derivedTitle: "Investigate queue",
      lastMessagePreview: "Use `[[reply_to_current]]` literally.",
      updatedAt: 100,
      archived: false,
      pinned: true,
      model: "gpt-5.6-sol",
      contextTokens: 1_000_000,
      totalTokens: 1_200,
      status: "queued",
      abortedLastRun: false,
      childSessions: ["agent:main:subagent:grandchild"],
      createdActor: {
        type: "human",
        id: "profile-creator",
        label: "Creator",
        identity: { type: "profile", id: "profile-creator" },
      },
      owner: {
        actor: { type: "human", id: "profile-owner", label: "Owner" },
      },
      worktree: { id: "inventory-tree", branch: "fix/inventory", repoRoot: "/work/project" },
      repositoryWorkspaceId: "project-inventory",
      repository: {
        url: "https://example.invalid/project.git",
        ref: "main",
        branch: "fix/inventory",
      },
      execCwd: "/work/project/inventory",
      spawnedCwd: "/work/project",
      spawnedWorkspaceDir: "/work/workspace",
      projectId: "project-id",
      workspaceDir: "/work/project",
    };
    mocks.gatewayCall.mockResolvedValue({
      path: "/tmp/sessions.json",
      sessions: [
        {
          ...metadata,
          kind: "direct",
          classification: "subagent",
          category: "P1 issues",
          spawnedBy: "agent:main:main",
          createdActor: { ...metadata.createdActor, avatarUrl: "/private/creator-avatar" },
          owner: {
            actor: { ...metadata.owner.actor, avatarUrl: "/private/owner-avatar" },
            assignedBy: { type: "agent", id: "main" },
            assignedAt: 10,
          },
          deliveryContext: {
            channel: "discord",
            to: "private-target",
            accountId: "private-account",
            threadId: "private-thread",
          },
          origin: { provider: "discord", accountId: "private-account" },
          transcriptPath: "/private/transcript.jsonl",
          sessionRoot: "/private/session",
          lastTo: "private-target",
          lastAccountId: "private-account",
          permissionMode: "full",
          reasoningLevel: "deep",
          execNode: "private-node",
        },
      ],
    });
    mocks.getSessionStateVersions.mockReturnValue({
      main: { "agent:main:subagent:child": 4 },
    });
    const tool = createSessionsListTool({ config: VALID_CONFIG });
    const result = await tool.execute("contract", {});
    const linkedTool = createSessionsListTool({
      config: VALID_CONFIG,
      sessionLinkBase: SESSION_LINK_BASE,
    });
    const linkedResult = await linkedTool.execute("linked-contract", {});
    const linkedDetails = linkedResult.details as Record<string, unknown>;

    expect(tool.outputSchema).toBeDefined();
    expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
    expect(result.details).not.toHaveProperty("sessionLinkRule");
    expect(linkedDetails.sessionLinkRule).toBe(SESSION_LINK_RULE);
    expect(linkedTool.description.slice(-SESSION_LINK_RULE.length)).toBe(
      linkedDetails.sessionLinkRule,
    );
    const details = getSessionsListDetails(result);
    expect(Value.Check(tool.outputSchema!, { ...details, hasMore: "true" })).toBe(false);
    expect(Value.Check(tool.outputSchema!, { ...details, nextOffset: -1 })).toBe(false);
    expect(Value.Check(tool.outputSchema!, { ...details, limitApplied: 201 })).toBe(false);
    expect(Value.Check(tool.outputSchema!, { ...details, truncationReason: "unknown" })).toBe(
      false,
    );
    expect(
      Value.Check(tool.outputSchema!, {
        ...details,
        sessions: [{ ...details.sessions?.[0], deliveryContext: { channel: "discord" } }],
      }),
    ).toBe(false);
    expect(result.details).toEqual({
      count: 1,
      hasMore: false,
      limitApplied: 100,
      sessions: [
        {
          ...metadata,
          kind: "other",
          sidebarRoot: false,
          group: "P1 issues",
          parentSessionKey: "agent:main:main",
          stateVersion: 4,
        },
      ],
    });
  });
});
