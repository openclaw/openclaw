import { describe, expect, it, vi } from "vitest";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createGitHubPullRequestReadTool } from "./github-publish-tool.js";

describe("github_pull_request_read tool", () => {
  it("sends only the PR number under the host-owned caller identity", async () => {
    const callGateway = vi.fn().mockResolvedValue({ repository: "bic/lobster", number: 15913 });
    const tool = createGitHubPullRequestReadTool({ callGateway });
    const result = await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:repository-session" },
      () => tool.execute("tool-call", { pull_request: 15913 }),
    );

    expect(callGateway).toHaveBeenCalledWith("sessions.github.pullRequest.read", {
      sessionKey: "agent:main:repository-session",
      agentId: "main",
      pullRequest: 15913,
    });
    expect(JSON.stringify(result)).not.toMatch(/token|credential|argv|GH_TOKEN/u);
  });
});
