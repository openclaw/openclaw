import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { SANDBOX_DEFAULT_TOOL_ALLOW, type SandboxToolPolicy } from "../sandbox/types.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createSessionsCreateTool } from "./sessions-create-tool.js";
import { prepareSandboxSessionTools } from "./sessions-operator-authority.js";
import { withSessionToolTestCaller } from "./sessions-tool.test-helpers.js";

const gateway = vi.hoisted(() => ({ request: vi.fn(), available: true }));
vi.mock("./in-process-gateway.js", () => ({
  getInProcessGatewayToolContext: () => (gateway.available ? {} : undefined),
  bindAgentToolGatewayRequest: () => gateway.request,
}));

function issueAuthority(scopes: readonly string[] = ["operator.sessions.write"]) {
  const controller = new AbortController();
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "create-requester",
    scopes,
    signal: controller.signal,
    assertCurrent: () => {},
  });
  return { authority, revoke: () => controller.abort(new Error("creation source revoked")) };
}

beforeEach(() => {
  gateway.available = true;
  gateway.request.mockReset().mockResolvedValue({
    key: "agent:main:dashboard:created",
    sessionId: "created-session",
    runStarted: false,
  });
});

describe("sessions_create", () => {
  it("requires issued session-write authority and rejects a retained revoked source", async () => {
    expect(createSessionsCreateTool()).toBeNull();
    expect(
      createSessionsCreateTool({
        sessionControlAuthority: issueAuthority(["operator.read"]).authority,
      }),
    ).toBeNull();
    const { authority, revoke } = issueAuthority();
    const tool = expectDefined(
      createSessionsCreateTool({ sessionControlAuthority: authority }),
      "creation tool",
    );
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
    const { authority } = issueAuthority();
    await withSessionToolTestCaller(async () => {
      const tool = expectDefined(createSessionsCreateTool(), "creation tool");
      const params = {
        label: "Review",
        message: "  Review the patch.\n",
        agentId: "reviewer",
        cwd: "/workspace/project",
        group: "Reviews",
        model: "provider/model",
        permissionMode: "guarded",
      };
      gateway.request.mockResolvedValue({
        key: "agent:reviewer:dashboard:created",
        sessionId: "created-session",
        runStarted: false,
        runError: { code: "UNAVAILABLE", message: "Try the existing session later" },
      });
      const result = await tool.execute("create-one", params);
      expect(result.details).toEqual({
        sessionKey: "agent:reviewer:dashboard:created",
        sessionId: "created-session",
        runStarted: false,
        runError: { code: "UNAVAILABLE", message: "Try the existing session later" },
      });
      const request = gateway.request.mock.calls[0]?.[0];
      const { group, ...destination } = params;
      expect(request).toMatchObject({
        method: "sessions.create",
        params: { ...destination, category: group, idempotencyKey: expect.any(String) },
        sessionCreation: {
          via: "operator",
          actor: { type: "human", source: "profile", id: authority.profileId },
          requesterSessionKey: "agent:main:main",
        },
        agentToolCaller: { agentId: "main", assertCurrent: expect.any(Function) },
      });
      expect(request.params).not.toHaveProperty("group");
      for (const key of [
        "user",
        "action",
        "key",
        "parentSessionKey",
        "spawnDepth",
        "fork",
        "creator",
        "role",
      ]) {
        expect(request.params).not.toHaveProperty(key);
      }
      await tool.execute("create-one", params);
      expect(gateway.request.mock.calls[1]?.[0].params.idempotencyKey).toBe(
        request.params.idempotencyKey,
      );
      await tool.execute("create-idle", {});
      const idle = gateway.request.mock.calls[2]?.[0].params;
      expect(idle.agentId).toBe("main");
      expect(idle).not.toHaveProperty("message");
      expect(idle.idempotencyKey).not.toBe(request.params.idempotencyKey);
    }, authority);
  });

  it("rejects blank work, creation aliases, lineage, and unverified selectors before dispatch", async () => {
    const { authority } = issueAuthority();
    await withSessionToolTestCaller(async () => {
      const tool = expectDefined(createSessionsCreateTool(), "creation tool");
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
    }, authority);
    expect(gateway.request).not.toHaveBeenCalled();
  });

  it("uses only a verified selected participant's live operator authority", async () => {
    const { authority } = issueAuthority();
    const selected = createAdmittedRunOperatorAuthority({
      profileId: "selected-requester",
      scopes: ["operator.sessions.write"],
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    await withSessionToolTestCaller(async () => {
      const tool = expectDefined(createSessionsCreateTool(), "creation tool");
      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          personalToolParticipants: {
            accept: () => {},
            close: () => {},
            resolve: (user) => {
              if (user !== selected.profileId) {
                throw new Error("Select a current participant");
              }
              return {
                profileId: selected.profileId,
                senderId: "selected-sender",
                name: "Selected participant",
                operatorAuthority: selected,
                assertCurrent: () => selected.assertCurrent(),
              };
            },
          },
        },
        async () => {
          await expect(tool.execute("ambiguous", {})).rejects.toThrow(
            "Select a current participant",
          );
          await tool.execute("selected", { user: selected.profileId });
        },
      );
      expect(gateway.request).toHaveBeenCalledOnce();
      expect(gateway.request.mock.calls[0]?.[0].sessionCreation.actor.id).toBe(selected.profileId);
      expect(gateway.request.mock.calls[0]?.[0].params).not.toHaveProperty("user");
    }, authority);
  });
});

describe("default guest session tool exposure", () => {
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
