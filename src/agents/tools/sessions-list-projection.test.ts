// sessions_list tool tests cover session metadata projection, visibility
// helpers, and numeric argument validation.
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

import { VALID_CONFIG, getSessionsListDetails, sessionRow } from "./sessions-list.test-support.js";

describe("sessions-list inventory projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionStateVersions.mockReturnValue({});
  });

  it("declares a complete focused row contract", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:main:subagent:child",
          sessionId: "session-child",
          agentId: "main",
          kind: "direct",
          classification: "subagent",
          channel: "discord",
          label: "worker",
          category: "P1 issues",
          displayName: "Worker",
          derivedTitle: "Investigate queue",
          lastMessagePreview: "Use `[[reply_to_current]]` literally.",
          spawnedBy: "agent:main:main",
          updatedAt: 100,
          archived: false,
          pinned: true,
          model: "openai/gpt-5.4-mini",
          contextTokens: 20_000,
          totalTokens: 1_200,
          status: "queued",
          abortedLastRun: false,
          childSessions: ["agent:main:subagent:grandchild"],
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
    expect(tool.outputSchema).toMatchObject({
      required: expect.arrayContaining(["count", "sessions", "hasMore", "limitApplied"]),
      additionalProperties: false,
      properties: {
        hasMore: { type: "boolean" },
        nextOffset: { type: "integer", minimum: 0 },
        limitApplied: { type: "integer", minimum: 1, maximum: 200 },
        sessions: {
          items: {
            additionalProperties: false,
            properties: {
              createdActor: expect.any(Object),
              owner: expect.any(Object),
              worktree: expect.any(Object),
              repositoryWorkspaceId: { type: "string" },
            },
          },
        },
      },
    });
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
          key: "agent:main:subagent:child",
          sessionId: "session-child",
          agentId: "main",
          kind: "other",
          channel: "discord",
          archived: false,
          pinned: true,
          label: "worker",
          group: "P1 issues",
          displayName: "Worker",
          derivedTitle: "Investigate queue",
          lastMessagePreview: "Use `[[reply_to_current]]` literally.",
          parentSessionKey: "agent:main:main",
          updatedAt: 100,
          stateVersion: 4,
          model: "openai/gpt-5.4-mini",
          contextTokens: 20_000,
          totalTokens: 1_200,
          status: "queued",
          abortedLastRun: false,
          childSessions: ["agent:main:subagent:grandchild"],
        },
      ],
    });
  });

  it("preserves the context window already projected by the Gateway", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:main:main",
          agentId: "main",
          kind: "direct",
          classification: "main",
          model: "gpt-5.6-sol",
          contextTokens: 1_000_000,
        },
      ],
    });

    const result = await createSessionsListTool({ config: VALID_CONFIG }).execute(
      "gateway-context-window",
      {},
    );

    expect(getSessionsListDetails(result).sessions?.[0]?.contextTokens).toBe(1_000_000);
  });

  it("preserves owner, creator and workspace metadata without exposing private Gateway internals", async () => {
    const metadata = {
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
      path: "/private/sessions.sqlite",
      sessions: [
        {
          ...sessionRow("agent:main:dashboard:inventory"),
          ...metadata,
          createdActor: { ...metadata.createdActor, avatarUrl: "/private/creator-avatar" },
          owner: {
            actor: { ...metadata.owner.actor, avatarUrl: "/private/owner-avatar" },
            assignedBy: { type: "agent", id: "main" },
            assignedAt: 10,
          },
          category: "Inventory",
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
    const tool = createSessionsListTool({ config: VALID_CONFIG });

    const result = await tool.execute("metadata-inventory", {});

    expect(getSessionsListDetails(result).sessions).toEqual([
      {
        key: "agent:main:dashboard:inventory",
        agentId: "main",
        kind: "other",
        channel: "discord",
        archived: false,
        pinned: false,
        group: "Inventory",
        ...metadata,
      },
    ]);
    expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
  });
});
