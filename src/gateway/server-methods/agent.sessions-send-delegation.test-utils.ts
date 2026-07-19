// Imported by agent.test.ts to exercise signed sessions_send admission in its mocked module graph.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTurnAuthoritySnapshot,
  isIssuedTurnAuthoritySnapshot,
} from "../../plugins/turn-authority.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  digestSessionsSendAgentRequest,
  mintAgentRuntimeIdentityToken,
  type AgentRuntimeIdentity,
  type AgentRuntimeSessionsSendDelegation,
  verifyAgentRuntimeIdentityToken,
} from "../agent-runtime-identity-token.js";
import { prepareAgentRequestPreflight } from "./agent-request-preflight.js";
import {
  backendGatewayClient,
  describe0AfterEach0,
  getAgentTestMocks,
  invokeAgent,
  makeContext,
  primeMainAgentRun,
  useTestStateDir,
  waitForAgentCommandCall,
  type AgentHandlerArgs,
  type AgentParams,
} from "./agent.test-harness.js";

const mocks = getAgentTestMocks();

function createDelegatedRequest(sessionKey = "agent:main:main"): AgentParams {
  return {
    message: "[Inter-session message] inspect startup",
    sessionKey,
    idempotencyKey: "sessions-send-delegated-run",
    deliver: false,
    sourceReplyDeliveryMode: "message_tool_only",
    channel: "webchat",
    lane: "nested:agent:main:main",
    inputProvenance: {
      kind: "inter_session",
      sourceSessionKey: "agent:source:main",
      sourceChannel: "discord",
      sourceTool: "sessions_send",
    },
  };
}

function createDelegation(
  request: AgentParams,
  overrides?: Partial<AgentRuntimeSessionsSendDelegation>,
): AgentRuntimeSessionsSendDelegation {
  const turnAuthority = createTurnAuthoritySnapshot({
    principal: {
      kind: "sender",
      provider: "discord",
      accountId: "molty",
      senderId: "maintainer-1",
      senderIsOwner: false,
      isAuthorizedSender: true,
      roleIds: ["maintainers"],
    },
    agentId: "source",
    sessionKey: "agent:source:main",
    sessionId: "source-session-id",
    runId: "source-run-id",
    conversationId: "maintenance",
    parentConversationId: "maintenance-parent",
    threadId: "maintenance-thread",
    trigger: "channel",
    controllerKey: "sender:discord:molty:maintainer-1",
  });
  return {
    kind: "sessions_send",
    expiresAtMs: Date.now() + 60_000,
    targetAgentId: "main",
    targetSessionKey: "agent:main:main",
    requestDigest: digestSessionsSendAgentRequest(request),
    turnAuthority,
    ...overrides,
  };
}

function createDelegatedClient(
  request: AgentParams,
  delegation = createDelegation(request),
  runtimeIdentity?: AgentRuntimeIdentity,
): AgentHandlerArgs["client"] {
  const client = backendGatewayClient();
  if (!client) {
    throw new Error("expected backend Gateway client");
  }
  return {
    ...client,
    connect: {
      ...client.connect,
      // Transport admin rights must not widen the delegated sender principal.
      scopes: ["operator.write", "operator.admin"],
    },
    internal: {
      ...client.internal,
      agentRuntimeIdentity: runtimeIdentity ?? {
        kind: "agentRuntime",
        agentId: "source",
        sessionKey: "agent:source:main",
        gatewayMethods: ["agent"],
        sessionsSendDelegation: delegation,
      },
    },
  };
}

describe("gateway sessions_send delegation", () => {
  afterEach(describe0AfterEach0);

  it("rebinds canonical target execution while preserving the non-owner sender", async () => {
    const request = createDelegatedRequest();
    primeMainAgentRun();
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 1 },
    });

    await invokeAgent(request, { client: createDelegatedClient(request) });

    const call = await waitForAgentCommandCall<{
      senderIsOwner?: boolean;
      turnAuthority?: ReturnType<typeof createTurnAuthoritySnapshot>;
      runContext?: Record<string, unknown>;
    }>();
    expect(call.senderIsOwner).toBe(false);
    expect(isIssuedTurnAuthoritySnapshot(call.turnAuthority)).toBe(true);
    expect(call.turnAuthority).toMatchObject({
      authorization: {
        principal: {
          kind: "sender",
          provider: "discord",
          accountId: "molty",
          senderId: "maintainer-1",
          senderIsOwner: false,
          isAuthorizedSender: true,
          roleIds: ["maintainers"],
        },
        agentId: "main",
        sessionKey: "agent:main:main",
        runId: "sessions-send-delegated-run",
        conversationId: "maintenance",
        parentConversationId: "maintenance-parent",
        threadId: "maintenance-thread",
        trigger: "sessions_send",
      },
      controllerKey: "sender:discord:molty:maintainer-1",
    });
    expect(call.runContext).toMatchObject({
      messageChannel: "discord",
      accountId: "molty",
      senderId: "maintainer-1",
      currentChannelId: "maintenance",
      chatId: "maintenance",
      currentThreadTs: "maintenance-thread",
    });
  });

  it("binds a global target to the explicitly signed agent", async () => {
    const request = { ...createDelegatedRequest("global"), agentId: "main" };
    const delegation = createDelegation(request, {
      targetAgentId: "main",
      targetSessionKey: "global",
    });
    mocks.loadSessionEntry.mockReturnValue({
      cfg: { session: { scope: "global" } },
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "existing-session-id", updatedAt: Date.now() },
      canonicalKey: "global",
    });
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 1 },
    });

    await invokeAgent(request, { client: createDelegatedClient(request, delegation) });

    const call = await waitForAgentCommandCall<{
      agentId?: string;
      sessionKey?: string;
      turnAuthority?: ReturnType<typeof createTurnAuthoritySnapshot>;
    }>();
    expect(call).toMatchObject({ agentId: "main", sessionKey: "global" });
    expect(call.turnAuthority).toMatchObject({
      authorization: { agentId: "main", sessionKey: "global", trigger: "sessions_send" },
    });
  });

  it("admits a real signed custom unscoped target through preflight", async () => {
    await withTempDir({ prefix: "openclaw-sessions-send-custom-token-" }, async (root) => {
      useTestStateDir(root);
      const request = {
        ...createDelegatedRequest("custom-ops-session"),
        agentId: "ops",
        lane: "nested:agent:ops:custom-ops-session",
      };
      const delegation = createDelegation(request, {
        targetAgentId: "ops",
        targetSessionKey: "custom-ops-session",
      });
      const token = await mintAgentRuntimeIdentityToken({
        agentId: "source",
        sessionKey: "agent:source:main",
        gatewayMethods: ["agent"],
        sessionsSendDelegation: {
          targetAgentId: delegation.targetAgentId,
          targetSessionKey: delegation.targetSessionKey,
          request,
          turnAuthority: delegation.turnAuthority,
        },
      });
      const runtimeIdentity = await verifyAgentRuntimeIdentityToken(token);
      if (!runtimeIdentity?.sessionsSendDelegation) {
        throw new Error("expected verified sessions_send runtime identity");
      }
      const respond = vi.fn();

      const preflight = prepareAgentRequestPreflight({
        params: request,
        respond,
        context: makeContext(),
        client: createDelegatedClient(
          request,
          runtimeIdentity.sessionsSendDelegation,
          runtimeIdentity,
        ),
      });

      expect(respond).not.toHaveBeenCalled();
      expect(preflight).toMatchObject({
        request: {
          sessionKey: "custom-ops-session",
          agentId: "ops",
          lane: "nested:agent:ops:custom-ops-session",
        },
        sessionsSendDelegation: {
          targetAgentId: "ops",
          targetSessionKey: "custom-ops-session",
        },
      });

      const canonicalSessionKey = "agent:ops:custom-ops-session";
      mocks.listAgentIds.mockReturnValue(["main", "ops"]);
      mocks.loadSessionEntry.mockReturnValue({
        cfg: { agents: { list: [{ id: "main" }, { id: "ops" }] } },
        storePath: "/tmp/ops-sessions.json",
        entry: { sessionId: "custom-ops-session-id", updatedAt: Date.now() },
        canonicalKey: canonicalSessionKey,
        storeKeys: [canonicalSessionKey, "custom-ops-session"],
      });
      mocks.updateSessionStore.mockResolvedValue(undefined);
      mocks.agentCommand.mockReset().mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 1 },
      });

      await invokeAgent(request, {
        client: createDelegatedClient(
          request,
          runtimeIdentity.sessionsSendDelegation,
          runtimeIdentity,
        ),
      });

      const call = await waitForAgentCommandCall<{
        agentId?: string;
        sessionKey?: string;
        turnAuthority?: ReturnType<typeof createTurnAuthoritySnapshot>;
      }>();
      expect(call).toMatchObject({ agentId: "ops", sessionKey: canonicalSessionKey });
      expect(call.turnAuthority).toMatchObject({
        authorization: {
          agentId: "ops",
          sessionKey: canonicalSessionKey,
          trigger: "sessions_send",
        },
      });
    });
  });

  it("rejects a malformed agent target during delegated preflight", () => {
    const request = {
      ...createDelegatedRequest("agent::broken"),
      agentId: "ops",
    };
    const delegation = createDelegation(request, {
      targetAgentId: "ops",
      targetSessionKey: "agent::broken",
    });
    const respond = vi.fn();

    expect(
      prepareAgentRequestPreflight({
        params: request,
        respond,
        context: makeContext(),
        client: createDelegatedClient(request, delegation),
      }),
    ).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "invalid sessions_send authority delegation" }),
    );
  });

  it("rejects a global delegation without its explicit adjacent agent", async () => {
    const signedRequest = { ...createDelegatedRequest("global"), agentId: "main" };
    const request = createDelegatedRequest("global");
    const delegation = createDelegation(signedRequest, {
      targetAgentId: "main",
      targetSessionKey: "global",
    });
    mocks.updateSessionStore.mockClear();
    mocks.agentCommand.mockClear();

    const respond = await invokeAgent(request, {
      client: createDelegatedClient(signedRequest, delegation),
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "invalid sessions_send authority delegation" }),
    );
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("rejects a custom unscoped delegation without its explicit adjacent agent", async () => {
    const request = createDelegatedRequest("custom-ops-session");
    const delegation = createDelegation(request, {
      targetAgentId: "ops",
      targetSessionKey: "custom-ops-session",
    });
    mocks.updateSessionStore.mockClear();
    mocks.agentCommand.mockClear();

    const respond = await invokeAgent(request, {
      client: createDelegatedClient(request, delegation),
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "invalid sessions_send authority delegation" }),
    );
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("preserves delegated transcript text through Gateway admission", async () => {
    const request = createDelegatedRequest();
    const delegation = createDelegation(request, {
      transcriptMessage: "canonical user-visible transcript",
    });
    primeMainAgentRun();
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 1 },
    });

    await invokeAgent(request, { client: createDelegatedClient(request, delegation) });

    const call = await waitForAgentCommandCall<{
      transcriptMessage?: string;
      userTurnTranscriptRecorder?: { message?: { content?: string } };
    }>();
    expect(call.transcriptMessage).toBe("canonical user-visible transcript");
    expect(call.userTurnTranscriptRecorder?.message?.content).toBe(
      "canonical user-visible transcript",
    );
  });

  it("rejects request tampering before session or agent mutation", async () => {
    const signedRequest = createDelegatedRequest();
    const tamperedRequest = { ...signedRequest, message: "tampered after token mint" };
    const client = createDelegatedClient(signedRequest);
    mocks.updateSessionStore.mockClear();
    mocks.agentCommand.mockClear();

    const respond = await invokeAgent(tamperedRequest, { client });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "invalid sessions_send authority delegation" }),
    );
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "expired",
      mutate: (request: AgentParams) => createDelegation(request, { expiresAtMs: Date.now() - 1 }),
    },
    {
      label: "target-mismatched",
      mutate: (request: AgentParams) =>
        createDelegation(request, { targetSessionKey: "agent:other:main" }),
    },
  ])("rejects $label delegation before mutation", async ({ mutate }) => {
    const request = createDelegatedRequest();
    const client = createDelegatedClient(request, mutate(request));
    mocks.updateSessionStore.mockClear();
    mocks.agentCommand.mockClear();

    const respond = await invokeAgent(request, { client });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "invalid sessions_send authority delegation" }),
    );
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("rejects a signed noncanonical target before session mutation", async () => {
    const request = createDelegatedRequest("main");
    const delegation = createDelegation(request, { targetSessionKey: "main" });
    mocks.updateSessionStore.mockClear();
    mocks.agentCommand.mockClear();

    const respond = await invokeAgent(request, {
      client: createDelegatedClient(request, delegation),
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "invalid sessions_send authority delegation" }),
    );
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });
});
