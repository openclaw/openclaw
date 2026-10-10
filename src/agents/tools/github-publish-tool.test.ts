import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import { runWithAgentToolExecutionContext } from "../../../packages/agent-core/src/tool-execution-context.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createGitHubPublishTool } from "./github-publish-tool.js";
import type { InProcessGatewayCaller } from "./in-process-gateway.js";

describe("github_publish tool", () => {
  it.each(["responseId", "turnId"] as const)(
    "scopes reused call IDs by %s and keeps replays stable across runs",
    async (identityField) => {
      const callGatewayMock = vi.fn(async (_method: string, _params: Record<string, unknown>) => ({
        requestId: "publication-1",
        status: "requested" as const,
        message: "Publication was accepted.",
      }));
      const tool = createGitHubPublishTool({
        callGateway: callGatewayMock as InProcessGatewayCaller,
      });
      const calls = ["First publication", "Second publication"].map((title, index) => {
        const toolCall = {
          type: "toolCall" as const,
          id: "github_publish_0",
          name: tool.name,
          arguments: { title },
        };
        return {
          toolCall,
          assistantMessage: makeAssistantMessageFixture({
            [identityField]: `turn-${index + 1}`,
            stopReason: "toolUse",
            content: [toolCall],
          }),
        };
      });
      const first = expectDefined(calls[0], "first assistant turn");
      for (const [index, context] of [...calls, first, first].entries()) {
        await withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: "agent:main:host-owned",
            operationalRunInstance: {
              instanceId: "instance-1",
              runId: index === 3 ? "run-2" : "run-1",
            },
          },
          () =>
            runWithAgentToolExecutionContext(context, () =>
              tool.execute(context.toolCall.id, context.toolCall.arguments),
            ),
        );
      }

      expect(callGatewayMock.mock.calls.map(([, params]) => params)).toEqual([
        {
          sessionKey: "agent:main:host-owned",
          idempotencyKey: "turn-1:github_publish_0",
          title: "First publication",
        },
        {
          sessionKey: "agent:main:host-owned",
          idempotencyKey: "turn-2:github_publish_0",
          title: "Second publication",
        },
        {
          sessionKey: "agent:main:host-owned",
          idempotencyKey: "turn-1:github_publish_0",
          title: "First publication",
        },
        {
          sessionKey: "agent:main:host-owned",
          idempotencyKey: "turn-1:github_publish_0",
          title: "First publication",
        },
      ]);
    },
  );

  it("binds bounded model intent to the host-owned session", async () => {
    const callGatewayMock = vi.fn(async () => ({
      requestId: "publication-1",
      status: "requested" as const,
      message: "Publication was accepted.",
    }));
    const callGateway = callGatewayMock as InProcessGatewayCaller;
    const tool = createGitHubPublishTool({ callGateway });

    await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:host-owned" },
      async () => await tool.execute("tool-call-1", { title: "Publish the fix" }),
    );

    expect(callGatewayMock).toHaveBeenCalledWith("sessions.github.publish", {
      sessionKey: "agent:main:host-owned",
      idempotencyKey: "tool-call-1",
      title: "Publish the fix",
    });
  });
});
