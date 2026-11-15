import "./sessions-spawn-tool.mocks.test-support.js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { SANDBOX_DEFAULT_TOOL_ALLOW, type SandboxToolPolicy } from "../sandbox/types.js";
import { supportedSpawnModelChoice } from "../subagents/spawn/subagent-spawn.test-helpers.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { prepareSandboxSessionTools } from "./sessions-operator-authority.js";

const { hoisted } = await import("./sessions-spawn-tool.mocks.test-support.js");
let createSessionsCreateTool: typeof import("./sessions-create-tool.js").createSessionsCreateTool;

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

// A channel turn: a live agent caller with no admitted operator authority.
const channelKey = "agent:main:discord:channel:release";
const config = { agents: { defaults: { model: "mock-provider/primary" }, entries: { main: {} } } };

function createFromChannel(
  args: Record<string, unknown>,
  options: Parameters<typeof createSessionsCreateTool>[0] = {},
) {
  const tool = createSessionsCreateTool({
    agentSessionKey: channelKey,
    config,
    countActiveRuns: () => 0,
    ...options,
  });
  return withGatewayToolCallerIdentity({ agentId: "main", sessionKey: channelKey }, () =>
    tool.execute("create-call", args),
  );
}

describe("sessions_create", () => {
  beforeAll(async () => {
    ({ createSessionsCreateTool } = await import("./sessions-create-tool.js"));
  });

  beforeEach(() => {
    hoisted.prepareModelChoiceMock.mockReset().mockImplementation(supportedSpawnModelChoice);
    hoisted.inProcessCreationMock.mockReset().mockResolvedValue({
      key: "agent:main:dashboard:created",
      sessionId: "created-session",
      runStarted: true,
      runId: "created-run",
    });
  });

  it("creates an unsupervised session from a channel turn with visible-spawn authority", async () => {
    const registerRun = vi.fn();
    const result = await createFromChannel({ message: "draft the notes" }, { registerRun });

    expect(result.details).toEqual({
      sessionKey: "agent:main:dashboard:created",
      sessionId: "created-session",
      runStarted: true,
      runId: "created-run",
    });
    const [method, params, creation] = hoisted.inProcessCreationMock.mock.calls[0] ?? [];
    expect(method).toBe("sessions.create");
    // The brief arrives verbatim, without supervised-child framing.
    expect(params).toMatchObject({ task: "draft the notes", parentSessionKey: channelKey });
    expect(creation).toMatchObject({
      via: "spawn",
      actor: { type: "agent", id: "main" },
      requesterSessionKey: channelKey,
    });
    expect(creation).not.toHaveProperty("completionOwnerSessionKey");
    expect(registerRun).not.toHaveBeenCalled();
  });

  it("never creates a session less contained than the creating turn", async () => {
    await createFromChannel(
      {},
      {
        sessionPermissionPolicy: { root: "/workspace", mode: "guarded" },
        inheritedToolDenylist: ["exec"],
      },
    );
    expect(hoisted.inProcessCreationMock.mock.calls[0]?.[2]).toMatchObject({
      inheritedPermissionMode: "guarded",
      inheritedToolPolicy: { deny: ["exec"] },
    });

    hoisted.inProcessCreationMock.mockClear();
    const sandboxed = await createFromChannel({ message: "escape" }, { sandboxed: true });
    expect(sandboxed.details).toMatchObject({
      status: "forbidden",
      error: "Sandboxed sessions cannot spawn unsandboxed sessions.",
    });
    expect(hoisted.inProcessCreationMock).not.toHaveBeenCalled();
  });

  it("rejects blank work and options outside its destination schema before dispatch", async () => {
    for (const args of [
      { message: "  \n " },
      { key: "existing-session" },
      { parentSessionKey: "agent:main:main" },
      { permissionMode: "full" },
      { visible: false },
    ]) {
      await expect(createFromChannel(args)).rejects.toThrow();
    }
    expect(hoisted.inProcessCreationMock).not.toHaveBeenCalled();
  });
});

describe("prepareSandboxSessionTools", () => {
  it("projects only the captured operator grant, including its absence and revocation", async () => {
    const allow = ["read"];
    const policy: SandboxToolPolicy = { allow, deny: [], [SANDBOX_DEFAULT_TOOL_ALLOW]: allow };
    const captured = issueAuthority();
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:dashboard:catalog",
        operatorAuthority: issueAuthority(["operator.admin"], "other-requester").authority,
      },
      () => {
        for (const authority of [null, issueAuthority(["operator.read"]).authority]) {
          expect(prepareSandboxSessionTools({ policy, senderIsOwner: false, authority })).toEqual({
            policy,
            renameOnly: false,
          });
        }
        const params = { policy, senderIsOwner: false, authority: captured.authority };
        expect(prepareSandboxSessionTools(params).policy?.allow).toEqual([
          "read",
          "sessions",
          "sessions_create",
        ]);
        captured.revoke();
        expect(() => prepareSandboxSessionTools(params)).toThrow("creation source revoked");
      },
    );
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
