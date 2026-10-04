import { describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { createSessionsTool } from "./sessions-tool.js";
import { withSessionToolTestCaller } from "./sessions-tool.test-helpers.js";

const sessionKey = "agent:main:main";
describe("sessions tool ownership", () => {
  it.each([
    { senderIsOwner: false, controls: true },
    ...[true, false, undefined].map((senderIsOwner) => ({ senderIsOwner, controls: false })),
  ])("assigns an owner with posture %j", async ({ senderIsOwner, controls }) => {
    const controller = new AbortController();
    const authority = controls
      ? createAdmittedRunOperatorAuthority({
          profileId: "profile-requester",
          scopes: ["operator.write"],
          signal: controller.signal,
          assertCurrent: () => {},
        })
      : undefined;
    const actor = controls
      ? { type: "agent", id: "main" }
      : { type: "human", id: "profile-colin", label: "Colin" };
    const callGateway = vi.fn<AgentToolGatewayRequestCaller>().mockResolvedValue({
      ok: true,
      key: sessionKey,
      owner: {
        actor,
        assignedBy: { type: "agent", id: "main" },
        assignedAt: 10,
      },
    });
    await withSessionToolTestCaller(async () => {
      const tool = createSessionsTool({
        senderIsOwner,
        agentSessionKey: sessionKey,
        config: {},
        callGateway: callGateway as never,
      });
      const args = { action: "assign_owner", ownerType: actor.type, ownerId: actor.id };
      const assigned = await tool.execute("assign", args);
      expect(assigned.details).toMatchObject({ status: "updated", owner: actor });
      expect(callGateway).toHaveBeenCalledExactlyOnceWith({
        method: "sessions.assignOwner",
        params: { key: sessionKey, owner: { type: actor.type, id: actor.id } },
        agentToolCaller: { agentId: "main", sessionKey },
        assertDispatchCurrent: expect.any(Function),
      });
      if (!controls) {
        expect(assigned).toMatchObject({
          content: [{ type: "text", text: expect.stringContaining('"label": "Colin"') }],
        });
        return;
      }
      expect(tool.parameters).toHaveProperty("properties.action.enum", [
        "patch",
        "stop",
        "assign_owner",
      ]);
      expect(tool.parameters).toHaveProperty("properties.user");
      expect(tool.parameters).not.toHaveProperty("properties.model");
      for (const denied of [
        { action: "group_set", names: [] },
        { action: "patch", archived: true, model: "other" },
      ]) {
        await expect(tool.execute("settings-denied", denied)).rejects.toThrow(
          /only permits archive, restore, and stop/,
        );
      }
      expect(callGateway).toHaveBeenCalledOnce();
      controller.abort(new Error("operator source revoked"));
      await expect(tool.execute("retired-assign", args)).rejects.toThrow("operator source revoked");
      expect(callGateway).toHaveBeenCalledOnce();
    }, authority);
  });

  it.each([
    ...[false, undefined].map((senderIsOwner) => ({
      senderIsOwner,
      admitted: false,
      action: "assign_owner",
      target: sessionKey,
      error: "requires an admitted agent turn",
    })),
    {
      senderIsOwner: false,
      admitted: false,
      action: "patch",
      target: sessionKey,
      error: "Only assign_owner is available to non-owner callers",
    },
    ...[
      {
        target: "agent:main:dashboard:incognito-private",
        error: "Session not visible from session tools",
      },
      { target: "agent:other:main", error: "Session status visibility is restricted" },
    ].map(({ target, error }) => ({
      target,
      error,
      senderIsOwner: false,
      admitted: true,
      action: "assign_owner",
    })),
  ])(
    "denies $action for $target (admitted: $admitted, owner: $senderIsOwner)",
    async ({ senderIsOwner, admitted, action, target, error }) => {
      const callGateway = vi.fn();
      const tool = createSessionsTool({
        agentSessionKey: sessionKey,
        senderIsOwner,
        config: admitted ? { tools: { sessions: { visibility: "agent" } } } : {},
        callGateway,
      });
      const invoke = () =>
        tool.execute("denied", {
          action,
          sessionKey: target,
          ownerType: "human",
          ownerId: "profile-colin",
          senderIsOwner: true,
        });
      await expect(admitted ? withSessionToolTestCaller(invoke) : invoke()).rejects.toThrow(error);
      expect(callGateway).not.toHaveBeenCalled();
    },
  );
});
