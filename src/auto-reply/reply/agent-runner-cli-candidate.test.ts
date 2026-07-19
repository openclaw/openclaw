import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createTurnAuthoritySnapshot } from "../../plugins/turn-authority.js";
import {
  resolveCliAttemptTurnAuthority,
  resolveCliAuthorizationToolAvailability,
  resolveCliCandidateAdmissionParams,
} from "./agent-runner-cli-candidate.js";
import type { FollowupRun } from "./queue.js";

function makeCandidateRun(overrides: Partial<FollowupRun["run"]> = {}): FollowupRun["run"] {
  return {
    agentId: "agent-1",
    agentDir: "/tmp/agent",
    sessionId: "session-1",
    sessionKey: "agent:agent-1:discord:channel:maintenance",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    config: {},
    provider: "openai",
    model: "gpt-5.4",
    timeoutMs: 60_000,
    blockReplyBreak: "message_end",
    ...overrides,
  } as unknown as FollowupRun["run"];
}

describe("resolveCliAttemptTurnAuthority", () => {
  it("preserves admitted identity while rebinding final CLI execution identity", () => {
    const source = createTurnAuthoritySnapshot({
      principal: {
        kind: "sender",
        provider: "discord",
        accountId: "molty",
        senderId: "maintainer-1",
        senderIsOwner: false,
        isAuthorizedSender: true,
        roleIds: ["maintainers"],
      },
      agentId: "source-agent",
      sessionKey: "agent:source-agent:source",
      conversationId: "maintenance-thread",
      parentConversationId: "maintenance",
      threadId: "maintenance-thread",
      trigger: "channel",
      controllerKey: "sender:discord:molty:maintainer-1",
    });

    const rebound = resolveCliAttemptTurnAuthority({
      turnAuthority: source,
      agentId: "target-agent",
      sessionKey: "agent:target-agent:source-route",
      runtimePolicySessionKey: "agent:target-agent:discord:channel:maintenance",
      sessionId: "target-session",
      runId: "target-run",
      trigger: "user",
    });

    expect(rebound).toBeDefined();
    expect(rebound).not.toBe(source);
    expect(rebound?.authorization).toEqual({
      ...source.authorization,
      agentId: "target-agent",
      sessionKey: "agent:target-agent:discord:channel:maintenance",
      sessionId: "target-session",
      runId: "target-run",
      trigger: "user",
    });
    expect(rebound?.controllerKey).toBe(source.controllerKey);
    expect(rebound?.capabilityDigest).toBe(source.capabilityDigest);
    expect(source.authorization.sessionId).toBeUndefined();
    expect(source.authorization.runId).toBeUndefined();
  });
});

describe("resolveCliCandidateAdmissionParams", () => {
  it("uses issued authority instead of conflicting queued sender facts", () => {
    const source = createTurnAuthoritySnapshot({
      principal: {
        kind: "sender",
        provider: "discord",
        accountId: "molty",
        senderId: "maintainer-1",
        aliases: {
          name: "Trusted Maintainer",
          username: "trusted-maintainer",
          e164: "+15550001111",
        },
        senderIsOwner: false,
        isAuthorizedSender: false,
        roleIds: ["maintainers"],
      },
      agentId: "source-agent",
      sessionKey: "agent:source-agent:discord:channel:maintenance",
      conversationId: "maintenance-thread",
      parentConversationId: "maintenance",
      trigger: "channel",
    });
    const candidateRun = makeCandidateRun({
      turnAuthority: source,
      senderId: "queued-owner",
      senderName: "Queued Owner",
      senderUsername: "queued-owner",
      senderE164: "+15550009999",
      senderIsOwner: true,
      isAuthorizedSender: true,
      memberRoleIds: ["administrators"],
    });
    const attempt = resolveCliAttemptTurnAuthority({
      turnAuthority: source,
      agentId: candidateRun.agentId,
      sessionKey: candidateRun.sessionKey,
      sessionId: candidateRun.sessionId,
      runId: "run-1",
      trigger: "user",
    });

    const resolved = resolveCliCandidateAdmissionParams({
      candidateRun,
      attemptTurnAuthority: attempt,
    });

    expect(resolved).toMatchObject({
      turnAuthority: attempt,
      senderId: "maintainer-1",
      senderName: "trusted maintainer",
      senderUsername: "trusted-maintainer",
      senderE164: "+15550001111",
      senderIsOwner: false,
      isAuthorizedSender: false,
      memberRoleIds: ["maintainers"],
    });
  });

  it("keeps the immutable queued parent across deferred session rerouting", () => {
    const resolved = resolveCliCandidateAdmissionParams({
      candidateRun: makeCandidateRun(),
      originatingParentConversationId: "queued-parent",
      sessionParentConversationId: "rerouted-session-parent",
    });

    expect(resolved.parentConversationId).toBe("queued-parent");
  });
});

describe("resolveCliAuthorizationToolAvailability", () => {
  it("routes policy-active normal CLI candidates through managed MCP tools only", () => {
    const config = {
      plugins: {
        entries: {
          "sender-policy": {
            authorization: {
              requiredPolicies: [{ id: "sender-rights", operations: ["tool.call"] }],
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(resolveCliAuthorizationToolAvailability(config)).toEqual({
      native: [],
      mcp: ["mcp__openclaw__*"],
    });
  });

  it("fails closed when authorization policy discovery is unreadable", () => {
    const config = {} as OpenClawConfig;
    Object.defineProperty(config, "plugins", {
      get() {
        throw new Error("unreadable policy config");
      },
    });

    expect(resolveCliAuthorizationToolAvailability(config)).toEqual({
      native: [],
      mcp: ["mcp__openclaw__*"],
    });
  });
});
