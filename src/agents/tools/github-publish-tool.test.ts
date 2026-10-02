import { describe, expect, it, vi } from "vitest";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createGitHubPublishTool } from "./github-publish-tool.js";
import type { InProcessGatewayCaller } from "./in-process-gateway.js";

describe("github_publish tool", () => {
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
  it("prepares compact review metadata, reads explicit pages and confirms its exact identity", async () => {
    const reference = { reviewId: "bdca439a-e787-4f9f-b5f3-a878c662cc78", digest: "a".repeat(64) };
    const callGatewayMock = vi
      .fn()
      .mockResolvedValueOnce({
        ...reference,
        status: "ready",
        body: "Already supplied description",
        diffLength: 4,
      })
      .mockResolvedValueOnce({
        ...reference,
        offset: 0,
        nextOffset: null,
        totalCharacters: 4,
        complete: true,
        text: "diff",
      })
      .mockResolvedValueOnce({
        requestId: "reviewed-publication",
        status: "requested",
        message: "Waiting for accepted work.",
      });
    const tool = createGitHubPublishTool({
      callGateway: callGatewayMock as InProcessGatewayCaller,
    });
    await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:host-owned" },
      async () => {
        const prepared = await tool.execute("prepare-call", {
          action: "prepare",
          title: "Reviewed change",
          body: "Already supplied description",
        });
        expect(prepared.details).not.toHaveProperty("body");
        expect(prepared.details).not.toHaveProperty("diff");
        expect(callGatewayMock).toHaveBeenLastCalledWith("sessions.github.review", {
          sessionKey: "agent:main:host-owned",
          action: "prepare",
          idempotencyKey: "prepare-call",
          title: "Reviewed change",
          body: "Already supplied description",
        });
        const diff = await tool.execute("diff-call", {
          action: "diff",
          review: reference,
          offset: 0,
        });
        expect(diff.details).toMatchObject({ text: "diff", complete: true, nextOffset: null });
        await tool.execute("confirm-call", { action: "confirm", review: reference });
        expect(callGatewayMock).toHaveBeenLastCalledWith("sessions.github.publish", {
          sessionKey: "agent:main:host-owned",
          idempotencyKey: "confirm-call",
          review: reference,
        });
      },
    );
  });
  it("does not turn incomplete review arguments into direct publication", async () => {
    const callGatewayMock = vi.fn();
    const tool = createGitHubPublishTool({
      callGateway: callGatewayMock as InProcessGatewayCaller,
    });
    await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:host-owned" },
      async () => {
        await expect(tool.execute("missing-confirmation", { action: "confirm" })).rejects.toThrow(
          "reviewed candidate",
        );
        await expect(tool.execute("missing-page", { action: "diff" })).rejects.toThrow(
          "explicit offset",
        );
      },
    );
    expect(callGatewayMock).not.toHaveBeenCalled();
  });
});
