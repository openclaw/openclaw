import { describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { createSessionsTool } from "./sessions-tool.js";
import { withSessionToolTestCaller } from "./sessions-tool.test-helpers.js";

describe("sessions tool ownership", () => {
  it("composes admitted operator assignment with the existing bounded controls", async () => {
    const controller = new AbortController();
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "profile-requester",
      scopes: ["operator.write"],
      signal: controller.signal,
      assertCurrent: () => {},
    });
    const callGateway = vi.fn(async () => ({
      key: "agent:main:main",
      owner: { actor: { type: "agent", id: "main" } },
    }));
    await withSessionToolTestCaller(async () => {
      const tool = createSessionsTool({
        senderIsOwner: false,
        agentSessionKey: "agent:main:main",
        config: {},
        callGateway: callGateway as never,
      });
      expect(tool.parameters).toHaveProperty("properties.action.enum", [
        "patch",
        "stop",
        "assign_owner",
      ]);
      expect(tool.parameters).toHaveProperty("properties.user");
      expect(tool.parameters).not.toHaveProperty("properties.model");
      const assigned = await tool.execute("operator-assign", {
        action: "assign_owner",
        ownerType: "agent",
        ownerId: "main",
      });
      expect(assigned.details).toMatchObject({
        status: "updated",
        owner: { type: "agent", id: "main" },
      });
      for (const args of [
        { action: "group_set", names: [] },
        { action: "patch", archived: true, model: "other" },
      ]) {
        await expect(tool.execute("settings-denied", args)).rejects.toThrow(
          /only permits archive, restore, and stop/,
        );
      }
      expect(callGateway).toHaveBeenCalledOnce();
      controller.abort(new Error("operator source revoked"));
      await expect(
        tool.execute("retired-assign", {
          action: "assign_owner",
          ownerType: "agent",
          ownerId: "main",
        }),
      ).rejects.toThrow("operator source revoked");
      expect(callGateway).toHaveBeenCalledOnce();
    }, authority);
  });

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
    ].map((action) => ({ action, senderIsOwner: false })),
  )("rejects privileged $action for an explicit non-owner", async ({ action, senderIsOwner }) => {
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
  });

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
