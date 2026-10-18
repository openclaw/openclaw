import { expectDefined } from "@openclaw/normalization-core/expect";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { runWithAgentToolExecutionContext } from "../../../packages/agent-core/src/tool-execution-context.js";
import { finalizeAgentToolAvailability } from "../agent-tool-availability.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { createCronToolSchema } from "./cron-tool-schema.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createGitHubPublishTool } from "./github-publish-tool.js";
import type { InProcessGatewayCaller } from "./in-process-gateway.js";

describe("github_publish tool", () => {
  it.each(["edit", "refresh_base", "ready", "request_review"])(
    "rejects draft on %s without changing PR state",
    async (action) => {
      const callGateway = vi.fn();
      const tool = createGitHubPublishTool({ callGateway, actionsAvailable: true });
      await expect(
        withGatewayToolCallerIdentity(
          { agentId: "main", sessionKey: "agent:main:host-owned" },
          () => tool.execute("choice", { action, draft: false }),
        ),
      ).rejects.toThrow("draft only selects the state when publishing a new PR");
      expect(callGateway).not.toHaveBeenCalled();
    },
  );

  it("offers current-PR editing and readiness without privileged actions", () => {
    const tool = createGitHubPublishTool();
    expect(Value.Check(tool.parameters, { action: "edit" })).toBe(true);
    expect(
      Value.Check(tool.parameters, {
        action: "request_review",
        requestId: "a1111111-1111-4111-8111-111111111111",
        expectedHeadCommit: "a".repeat(40),
      }),
    ).toBe(true);
    expect(
      Value.Check(tool.parameters, { action: "request_review", focus: "extra instructions" }),
    ).toBe(false);
    expect(
      Value.Check(tool.parameters, {
        action: "edit",
        title: "New title",
        expectedTitle: "Old title",
      }),
    ).toBe(true);
    expect(Value.Check(tool.parameters, { action: "ready" })).toBe(true);
    expect(Value.Check(tool.parameters, { action: "ready", publishingSessionKey: "another" })).toBe(
      false,
    );
    for (const action of ["inspect", "merge", "close"]) {
      expect(Value.Check(tool.parameters, { action })).toBe(false);
    }
    expect(Value.Check(tool.parameters, { action: "edit", publishingSessionKey: "another" })).toBe(
      false,
    );
    expect(tool.description).toContain("used only when creating a PR");
    expect(tool.description).toContain("Edit never synchronizes, stages, commits or pushes");
    expect(
      Value.Check(
        createGitHubPublishTool({ publicationAvailable: false, actionsAvailable: true }).parameters,
        { action: "edit" },
      ),
    ).toBe(false);
  });

  it.each(["available", "absent", "self-scoped", "denied"] as const)(
    "offers a scheduled continuation only with %s automation creation",
    (availability) => {
      const publish = createGitHubPublishTool();
      const automations = {
        name: "automations",
        description: "Schedule work",
        parameters: createCronToolSchema({ selfRemoveOnly: availability === "self-scoped" }),
      };
      finalizeAgentToolAvailability(
        [publish, ...(availability === "absent" ? [] : [automations])],
        availability === "denied" ? { toolExecutionAllow: ["github_publish"] } : undefined,
      );
      if (availability === "available") {
        expect(publish.description).toContain(
          'automations: at + agentTurn + sessionTarget "session:<this session key from Runtime>"',
        );
      } else {
        expect(publish.description).not.toContain("automations:");
        expect(publish.description).toContain("a scheduled continuation is unavailable");
      }
    },
  );

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

  it.each([undefined, false, true])(
    "preserves the draft choice %s in bounded model intent",
    async (draft) => {
      const callGatewayMock = vi.fn(async () => ({
        requestId: "publication-1",
        status: "requested" as const,
        message: "Publication was accepted.",
      }));
      const callGateway = callGatewayMock as InProcessGatewayCaller;
      const tool = createGitHubPublishTool({ callGateway });

      await withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey: "agent:main:host-owned" },
        async () =>
          await tool.execute("tool-call-1", {
            title: "Publish the fix",
            ...(draft !== undefined ? { draft } : {}),
          }),
      );

      expect(callGatewayMock).toHaveBeenCalledWith("sessions.github.publish", {
        sessionKey: "agent:main:host-owned",
        idempotencyKey: "tool-call-1",
        title: "Publish the fix",
        ...(draft !== undefined ? { draft } : {}),
      });
    },
  );
});
