import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReplyTurnParticipants } from "../../sessions/session-controller.tool-authority.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { captureRequesterOrigin } from "../requester-origin.js";
import { SANDBOX_DEFAULT_TOOL_ALLOW, type SandboxToolPolicy } from "../sandbox/types.js";
import type { AnyAgentTool } from "./common.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createSessionsCreateTool } from "./sessions-create-tool.js";
import { prepareSandboxSessionTools } from "./sessions-operator-authority.js";
import { withSessionToolTestCaller } from "./sessions-tool.test-helpers.js";

const gateway = vi.hoisted(() => ({ request: vi.fn(), available: true }));
// mock-isolation: Keep Gateway runtime state and dispatch outside this tool-contract fixture.
vi.mock("./in-process-gateway.js", () => ({
  getInProcessGatewayToolContext: () => (gateway.available ? {} : undefined),
  bindAgentToolGatewayRequest: () => gateway.request,
}));

function issueAuthority(
  scopes: readonly string[] = ["operator.sessions.write"],
  profileId = "create-requester",
) {
  const controller = new AbortController();
  const authority = createAdmittedRunOperatorAuthority({
    profileId,
    scopes,
    signal: controller.signal,
    assertCurrent: () => {},
  });
  return { authority, revoke: () => controller.abort(new Error("creation source revoked")) };
}

const created = {
  key: "agent:main:dashboard:created",
  sessionId: "created-session",
  runStarted: false,
};
function withTool(check: (tool: AnyAgentTool) => Promise<void>) {
  return withSessionToolTestCaller(
    () => check(createSessionsCreateTool()),
    issueAuthority().authority,
  );
}

beforeEach(() => {
  gateway.available = true;
  gateway.request.mockReset().mockResolvedValue(created);
});

describe("sessions_create", () => {
  it("keeps the definition stable while refusing calls without session-write authority", async () => {
    const denied = [
      createSessionsCreateTool(),
      createSessionsCreateTool({
        sessionControlAuthority: issueAuthority(["operator.read"]).authority,
      }),
    ];
    await withTool(async (authorized) => {
      for (const tool of denied) {
        expect(tool.name).toBe(authorized.name);
        expect(tool.description).toBe(authorized.description);
        expect(tool.parameters).toEqual(authorized.parameters);
        const result = await tool.execute("denied", {});
        expect(result.details).toMatchObject({ gated: true });
        expect(JSON.stringify(result.content)).toContain("session write authority");
      }
    });
    expect(gateway.request).not.toHaveBeenCalled();
  });

  it("requires issued authority and rejects a retained revoked source", async () => {
    const { authority, revoke } = issueAuthority();
    const tool = createSessionsCreateTool({ sessionControlAuthority: authority });
    expect(tool.parameters).not.toHaveProperty("properties.action");
    expect(tool.parameters).toHaveProperty("additionalProperties", false);
    expect(() => createSessionsCreateTool({ sessionControlAuthority: { ...authority } })).toThrow(
      /issued by the host/i,
    );
    await withSessionToolTestCaller(async () => {
      revoke();
      await expect(tool.execute("revoked", {})).rejects.toThrow("creation source revoked");
    }, authority);
    expect(gateway.request).not.toHaveBeenCalled();
  });

  it("keeps the approved destination choices separate from host identity and retry identity", async () => {
    await withTool(async (tool) => {
      const params = {
        label: "Review",
        message: "  Review the patch.\n",
        agentId: "reviewer",
        cwd: "/workspace/project",
        group: "Reviews",
        model: "provider/model",
        permissionMode: "guarded",
      };
      const runError = { code: "UNAVAILABLE", message: "Try the existing session later" };
      const { key: _key, ...receipt } = created;
      const key = "agent:reviewer:dashboard:created";
      gateway.request.mockResolvedValue({ ...receipt, key, runError });
      const result = await tool.execute("create-one", params);
      expect(result.details).toEqual({
        sessionKey: key,
        ...receipt,
        runError,
      });
      const request = gateway.request.mock.calls[0]?.[0];
      const { group, ...destination } = params;
      expect(request).toMatchObject({
        method: "sessions.create",
        sessionCreation: {
          via: "operator",
          actor: { type: "human", source: "profile", id: "create-requester" },
          requesterSessionKey: "agent:main:main",
        },
        agentToolCaller: { agentId: "main", assertCurrent: expect.any(Function) },
      });
      expect(request.params).toEqual({
        ...destination,
        category: group,
        idempotencyKey: expect.any(String),
      });
      await tool.execute("create-one", params);
      expect(gateway.request.mock.calls[1]?.[0].params.idempotencyKey).toBe(
        request.params.idempotencyKey,
      );
      await tool.execute("create-idle", {});
      const idle = gateway.request.mock.calls[2]?.[0].params;
      expect(idle.agentId).toBe("main");
      expect(idle).not.toHaveProperty("message");
      expect(idle.idempotencyKey).not.toBe(request.params.idempotencyKey);
    });
  });

  it("rejects blank work, creation aliases, lineage, and unverified selectors before dispatch", async () => {
    await withTool(async (tool) => {
      for (const args of [
        null,
        [],
        "create",
        { message: "  \n " },
        { action: "create" },
        { key: "existing-session" },
        { parentSessionKey: "agent:main:main" },
        { creator: "model-selected-person" },
        { permissionMode: "unknown" },
        { user: "unverified-person" },
      ]) {
        await expect(tool.execute("invalid", args)).rejects.toThrow();
      }
      const aborted = new AbortController();
      aborted.abort(new Error("creation call cancelled"));
      await expect(tool.execute("cancelled", {}, aborted.signal)).rejects.toThrow(
        "creation call cancelled",
      );
      gateway.available = false;
      await expect(tool.execute("no-gateway", {})).rejects.toThrow(/in-process Gateway/);
    });
    expect(gateway.request).not.toHaveBeenCalled();
  });

  it("uses only a verified selected participant's live operator authority", async () => {
    const { authority: selected, revoke } = issueAuthority(undefined, "selected-requester");
    const requesterOrigin = captureRequesterOrigin({
      sessionKey: "agent:main:main",
      operatorProfileId: selected.profileId,
      messageProvider: "webchat",
      senderId: "selected-sender",
    });
    const participants = createReplyTurnParticipants({
      operatorAuthority: issueAuthority().authority,
    });
    participants.accept({ operatorAuthority: selected });
    try {
      await withTool(async (tool) => {
        await withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: "agent:main:main",
            personalToolParticipants: participants,
          },
          async () => {
            await tool.execute("incumbent", {});
            await expect(
              tool.execute("missing-origin", { user: selected.profileId }),
            ).rejects.toThrow("Selected user's requester identity is unavailable");
            expect(gateway.request).toHaveBeenCalledOnce();
            participants.accept({ operatorAuthority: selected, requesterOrigin });
            await tool.execute("selected", { user: selected.profileId });
            revoke();
            await expect(
              tool.execute("revoked-selected", { user: selected.profileId }),
            ).rejects.toThrow(/access changed|creation source revoked/);
          },
        );
        expect(gateway.request).toHaveBeenCalledTimes(2);
        expect(gateway.request.mock.calls[1]?.[0].sessionCreation.actor).toEqual({
          type: "human",
          source: "profile",
          id: selected.profileId,
        });
        expect(gateway.request.mock.calls[1]?.[0].agentToolCaller.requesterOrigin).toEqual({
          ...requesterOrigin,
          delegatedCreatorProfileId: null,
        });
        expect(gateway.request.mock.calls[1]?.[0].params).not.toHaveProperty("user");
      });
    } finally {
      participants.close();
    }
  });
  it.each([
    { deny: [], added: ["sessions", "sessions_create"], renameOnly: true },
    { deny: ["sessions_create"], added: ["sessions"], renameOnly: true },
    { deny: ["sessions"], added: ["sessions_create"], renameOnly: false },
    { deny: ["sessions*"], added: [], renameOnly: false },
    { deny: ["group:sessions"], added: [], renameOnly: false },
  ])("preserves deny precedence for $deny", ({ deny, added, renameOnly }) => {
    const allow = ["read"];
    const policy: SandboxToolPolicy = { allow, deny, [SANDBOX_DEFAULT_TOOL_ALLOW]: allow };
    const result = prepareSandboxSessionTools({
      policy,
      senderIsOwner: false,
      authority: issueAuthority().authority,
    });
    expect(result.policy?.allow).toEqual([...allow, ...added]);
    expect(result.renameOnly).toBe(renameOnly);
    expect(policy.allow).toBe(allow);
  });

  it("does not expand explicit allowlists or senderless/insufficient-authority defaults", () => {
    const explicit = { allow: ["read"], deny: [] };
    const inherited: SandboxToolPolicy = {
      ...explicit,
      [SANDBOX_DEFAULT_TOOL_ALLOW]: explicit.allow,
    };
    const authority = issueAuthority().authority;
    for (const params of [
      { policy: explicit, senderIsOwner: false, authority },
      { policy: inherited, senderIsOwner: undefined, authority },
      { policy: inherited, senderIsOwner: false },
      {
        policy: inherited,
        senderIsOwner: false,
        authority: issueAuthority(["operator.read"]).authority,
      },
    ]) {
      expect(prepareSandboxSessionTools(params)).toEqual({
        policy: params.policy,
        renameOnly: false,
      });
    }
  });
});
