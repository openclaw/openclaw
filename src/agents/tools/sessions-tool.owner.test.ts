import { describe, expect, it, vi } from "vitest";
import { createSessionsTool } from "./sessions-tool.js";
import { withSessionToolTestCaller } from "./sessions-tool.test-helpers.js";

describe("sessions tool ownership", () => {
  it.each([false, undefined])(
    "rejects unadmitted assignment with owner posture %s",
    async (senderIsOwner) => {
      const callGateway = vi.fn();
      const tool = createSessionsTool({
        senderIsOwner,
        agentSessionKey: "agent:main:main",
        config: {},
        callGateway,
      });
      await expect(
        tool.execute("unadmitted", {
          action: "assign_owner",
          ownerType: "human",
          ownerId: "profile-colin",
        }),
      ).rejects.toThrow("requires an admitted agent turn");
      expect(callGateway).not.toHaveBeenCalled();
    },
  );

  it.each([true, false, undefined])(
    "assigns a visible session owner (senderIsOwner=%s)",
    async (senderIsOwner) => {
      const callGateway = vi.fn(async (request: { method: string }) => {
        if (request.method !== "sessions.assignOwner") {
          throw new Error(`unexpected method: ${request.method}`);
        }
        return {
          ok: true,
          key: "agent:main:main",
          owner: {
            actor: { type: "human", id: "profile-colin", label: "Colin" },
            assignedBy: { type: "agent", id: "main" },
            assignedAt: 10,
          },
        };
      });
      const tool = createSessionsTool({
        agentSessionKey: "agent:main:main",
        config: {},
        callGateway: callGateway as never,
        senderIsOwner,
      });

      const result = await withSessionToolTestCaller(() =>
        tool.execute("assign-colin", {
          action: "assign_owner",
          ownerType: "human",
          ownerId: "profile-colin",
        }),
      );

      expect(callGateway).toHaveBeenCalledWith({
        method: "sessions.assignOwner",
        params: {
          key: "agent:main:main",
          owner: { type: "human", id: "profile-colin" },
        },
        agentToolCaller: { agentId: "main", sessionKey: "agent:main:main" },
        assertDispatchCurrent: expect.any(Function),
      });
      expect(result).toMatchObject({
        content: [
          {
            type: "text",
            text: expect.stringContaining('"label": "Colin"'),
          },
        ],
      });
    },
  );

  it.each(
    [
      "cloud_profiles",
      "patch",
      "reset",
      "delete",
      "group_list",
      "group_set",
      "group_rename",
      "group_delete",
    ].flatMap((action) => [false, undefined].map((senderIsOwner) => ({ action, senderIsOwner }))),
  )(
    "rejects privileged $action with owner posture $senderIsOwner",
    async ({ action, senderIsOwner }) => {
      const callGateway = vi.fn();
      const tool = createSessionsTool({
        agentSessionKey: "agent:main:main",
        senderIsOwner,
        config: {},
        callGateway,
      });
      await expect(tool.execute("denied", { action, senderIsOwner: true })).rejects.toThrow(
        "Only assign_owner is available to non-owner callers",
      );
      expect(callGateway).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      sessionKey: "agent:main:dashboard:incognito-private",
      error: "Session not visible from session tools",
    },
    { sessionKey: "agent:other:main", error: "Session status visibility is restricted" },
  ])("keeps assignment visibility checks for $sessionKey", async ({ sessionKey, error }) => {
    const callGateway = vi.fn();
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      senderIsOwner: false,
      config: { tools: { sessions: { visibility: "agent" } } },
      callGateway,
    });
    await expect(
      withSessionToolTestCaller(() =>
        tool.execute("hidden-owner", {
          action: "assign_owner",
          sessionKey,
          ownerType: "human",
          ownerId: "profile-colin",
        }),
      ),
    ).rejects.toThrow(error);
    expect(callGateway).not.toHaveBeenCalled();
  });
});
