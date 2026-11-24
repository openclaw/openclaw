import { afterEach, describe, expect, it, vi } from "vitest";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createGitHubIdentityStatusTool } from "./github-identity-status-tool.js";
import * as gateway from "./in-process-gateway.js";

afterEach(() => vi.restoreAllMocks());

const expiredOAuth = {
  credentialKind: "managed-oauth",
  credentialState: "configured_unavailable",
  refreshState: "expired",
};

describe("github_identity_status tool", () => {
  it.each([
    {
      name: "returns status and an operator next action",
      supportsSettings: true,
      effective: expiredOAuth,
      guidance: "github_identity_settings",
    },
    {
      name: "gives manual guidance for an older Control UI",
      supportsSettings: false,
      effective: { ...expiredOAuth, refreshState: "unavailable" },
      guidance: "Settings → Profile → GitHub accounts",
    },
    {
      name: "keeps an unverified GitHub App on the verification path even when reconnect is available",
      supportsSettings: true,
      effective: {
        credentialKind: "app-installation",
        credentialState: "unverified",
        refreshState: "not_applicable",
      },
      guidance: "verified during an authorized operation, including scheduled automation",
    },
  ])("$name", async ({ supportsSettings, effective, guidance }) => {
    const callGatewayMock = vi.spyOn(gateway, "callInProcessGatewayTool").mockResolvedValue({
      effective,
    });
    const tool = createGitHubIdentityStatusTool(
      supportsSettings ? { clientCaps: ["ui-agent-github-settings"] } : {},
    );
    const result = await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:status" },
      async () => await tool.execute("status", {}),
    );

    expect(callGatewayMock).toHaveBeenCalledWith("tools.github.status", {
      agentId: "main",
      selectedScope: "agent",
    });
    expect(result.details).toMatchObject({
      effective,
      nextAction: expect.stringContaining(guidance),
    });
    expect(JSON.stringify(result).includes("github_identity_settings")).toBe(
      guidance === "github_identity_settings",
    );
  });
});
