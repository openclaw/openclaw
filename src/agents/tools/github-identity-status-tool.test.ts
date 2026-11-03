import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { finalizeAgentToolAvailability } from "../agent-tool-availability.js";
import { createStubTool } from "../test-helpers/agent-tool-stubs.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createGitHubIdentityStatusTool } from "./github-identity-status-tool.js";
import type { InProcessGatewayCaller } from "./in-process-gateway.js";

describe("github_identity_status tool", () => {
  it("returns status and an operator next action", async () => {
    const callGatewayMock = vi.fn(async () => ({
      agentId: "main",
      selectedScope: "agent" as const,
      selected: { scope: "agent" as const, configured: false, identity: null },
      effective: {
        source: "system-configured" as const,
        credentialKind: "managed-oauth" as const,
        credentialState: "configured_unavailable" as const,
        account: { login: "roboclaw-bot" },
        gitAuthor: { name: "roboclaw-bot", email: null },
        evidence: "none" as const,
        accessExpiresAtMs: 1_900_000_000_000,
        refreshState: "expired" as const,
        oauthScopes: ["repo", "workflow"],
        repositoryGrants: "unknown" as const,
      },
    }));
    const tool = createGitHubIdentityStatusTool({
      callGateway: callGatewayMock as InProcessGatewayCaller,
    });

    const result = await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:status" },
      async () => await tool.execute("status-1", {}),
    );

    expect(callGatewayMock).toHaveBeenCalledWith("tools.github.status", {
      agentId: "main",
      selectedScope: "agent",
    });
    expect(JSON.stringify(result)).toContain("Ask the operator");
  });

  it("directs capable sessions to the masked reconnect action", async () => {
    const callGateway = vi.fn(async () => ({
      agentId: "main",
      selectedScope: "agent" as const,
      selected: { scope: "agent" as const, configured: false, identity: null },
      effective: {
        source: "system-configured" as const,
        credentialKind: "managed-oauth" as const,
        credentialState: "configured_unavailable" as const,
        account: null,
        gitAuthor: null,
        evidence: "none" as const,
        accessExpiresAtMs: null,
        refreshState: "unavailable" as const,
        oauthScopes: [],
        repositoryGrants: "unknown" as const,
      },
    }));
    const tool = createGitHubIdentityStatusTool({
      callGateway: callGateway as InProcessGatewayCaller,
      clientCaps: ["ui-agent-github-settings"],
    });

    const result = await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:status" },
      async () => await tool.execute("status-2", {}),
    );

    expect(JSON.stringify(result)).toContain("github_identity_settings");

    const screen = {
      ...createStubTool("screen"),
      parameters: Type.Object({
        action: Type.Unsafe<string>({
          type: "string",
          enum: ["github_identity_settings", "status"],
        }),
      }),
    };
    for (const tools of [[tool], [tool, screen]]) {
      finalizeAgentToolAvailability(tools, { toolExecutionAllow: ["github_identity_status"] });
      const unavailable = await withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey: "agent:main:status" },
        () => tool.execute("denied", {}),
      );
      expect(JSON.stringify(unavailable)).toContain("Ask the operator to open Settings");
    }
    finalizeAgentToolAvailability([tool, screen]);
    const available = await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:status" },
      () => tool.execute("available", {}),
    );
    expect(JSON.stringify(available)).toContain("Use screen action github_identity_settings");
    expect(tool.description).toContain("github_identity_settings");
    finalizeAgentToolAvailability([
      tool,
      { ...screen, parameters: Type.Object({ action: Type.Literal("status") }) },
    ]);
    const unsupported = await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:status" },
      () => tool.execute("unsupported", {}),
    );
    expect(JSON.stringify(unsupported)).toContain("Ask the operator to open Settings");
    expect(tool.description).not.toContain("github_identity_settings");
  });
});
