import { expectDefined } from "@openclaw/normalization-core";
// System-agent session tests cover caller ownership and response projection.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import {
  requestChat,
  expectUnused,
  type ChatResponse,
} from "./system-agent-chat-fixture.test-support.js";
import { systemAgentHandlers, type SystemAgentChatSession } from "./system-agent.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

// Register the shared mocks before importing Gateway modules.
const {
  chatFixture,
  resetChatFixture,
  makeOwnershipEngine: makeEngine,
} = await vi.hoisted(async () => await import("./system-agent-chat-harness.test-support.js"));

const {
  inference: inferenceFallbackMocks,
  transcript: transcriptStoreMocks,
  ownershipEngines: createdEngines,
  engineOptions: createdEngineOptions,
} = chatFixture;
vi.mock("../../system-agent/overview.js", () => ({
  formatSystemAgentStartupMessage: vi.fn(() => "welcome text"),
}));

type RespondCall = ChatResponse;

function makeClient(params: {
  connId: string;
  deviceId?: string;
  authenticatedUserId?: string;
  profileId?: string;
  githubSyncPending?: boolean;
}): GatewayClient {
  return {
    connId: params.connId,
    connect: {
      client: { id: "openclaw-control-ui", mode: "webchat" },
      ...(params.deviceId ? { device: { id: params.deviceId } } : {}),
    },
    authenticatedUserId: params.authenticatedUserId,
    authenticatedUserProfile: params.profileId ? { profileId: params.profileId } : undefined,
    authenticatedGitHubIdentitySync: params.githubSyncPending
      ? async () => ({ profileId: "pending", updatedAt: 1 })
      : undefined,
  } as GatewayClient;
}

const defaultClient = makeClient({ connId: "conn-test", deviceId: "device-test" });

let sessions: Map<string, SystemAgentChatSession>;
let context: GatewayRequestContext;

function seededSession(engine = makeEngine()): SystemAgentChatSession {
  return {
    engine,
    welcome: "welcome text",
    lastUsedAt: 1,
    ownerKey: "device:device-test",
  } as unknown as SystemAgentChatSession;
}

function callChat(
  requestContext: GatewayRequestContext,
  params: Record<string, unknown>,
  client: GatewayClient | null = defaultClient,
) {
  return requestChat(systemAgentHandlers["openclaw.chat"], requestContext, params, client);
}

function sessionContext(engine = makeEngine()) {
  sessions.set("s1", seededSession(engine));
  return context;
}

function expectInvalid(call: RespondCall, invalidated = false) {
  expect(call).toMatchObject({
    ok: false,
    payload: undefined,
    error: {
      code: "INVALID_REQUEST",
      ...(invalidated ? { details: { code: "system_agent_session_invalidated" } } : {}),
    },
  });
}

beforeEach(() => {
  sessions = new Map();
  context = { systemAgentSessions: sessions } as unknown as GatewayRequestContext;
  resetChatFixture("ownership");
});

afterEach(() => {
  vi.clearAllMocks();
  resetCommandQueueStateForTest();
});

it("binds a new non-delegated session and rejects another principal", async () => {
  const owner = makeClient({
    connId: "conn-owner",
    deviceId: "device-owner",
    authenticatedUserId: "owner@example.com",
  });
  const attacker = makeClient({
    connId: "conn-attacker",
    deviceId: "device-attacker",
    authenticatedUserId: "attacker@example.com",
  });

  expect(await callChat(context, { sessionId: "owned-session" }, owner)).toMatchObject({
    ok: true,
  });
  expect(sessions.get("owned-session")?.ownerKey).toBe("user:owner@example.com");
  const handle = expectDefined(createdEngines[0], "created system-agent engine").handle;

  for (const params of [
    { message: "show status" },
    { message: "yes" },
    { reset: true },
    { wizardCancel: { stepId: "channel" } },
  ]) {
    const rejected = await callChat(context, { sessionId: "owned-session", ...params }, attacker);
    expectInvalid(rejected, params.message === "show status");
  }
  expect(handle).not.toHaveBeenCalled();
  const engine = expectDefined(createdEngines[0], "created system-agent engine");
  expectUnused(engine.cancelWizard, engine.dispose);
});

it("preserves the live session and pending approval when reset persistence fails", async () => {
  const engine = makeEngine();
  const session = seededSession(engine);
  session.pendingApproval = {
    id: "approval-1",
    proposalHash: "proposal-1",
    completion: Promise.resolve({ text: "Denied", action: "none" }),
  };
  sessions.set("owned-session", session);
  const expire = vi.fn();
  context = {
    ...context,
    systemAgentApprovalManager: { expire },
  } as unknown as GatewayRequestContext;
  transcriptStoreMocks.appendReset.mockImplementationOnce(() => {
    throw new Error("transcript store unavailable");
  });

  await expect(callChat(context, { sessionId: "owned-session", reset: true })).rejects.toThrow(
    "transcript store unavailable",
  );

  expect(transcriptStoreMocks.appendReset).toHaveBeenCalledOnce();
  expect(sessions.get("owned-session")).toBe(session);
  expect(session.pendingApproval).toEqual({
    id: "approval-1",
    proposalHash: "proposal-1",
    completion: expect.any(Promise),
  });
  expectUnused(
    expire,
    engine.dispose,
    inferenceFallbackMocks.verifySystemAgentInferenceWithFallback,
  );
});

it("uses the immutable profile across a GitHub login rename", async () => {
  await callChat(
    context,
    { sessionId: "github-rename" },
    makeClient({
      connId: "conn-old",
      authenticatedUserId: "old-login@github",
      profileId: "profile-account-a",
    }),
  );
  const handle = expectDefined(createdEngines[0], "created system-agent engine").handle;

  const resumed = await callChat(
    context,
    { sessionId: "github-rename", message: "continue" },
    makeClient({
      connId: "conn-new",
      authenticatedUserId: "new-login@github",
      profileId: "profile-account-a",
    }),
  );

  expect(sessions.get("github-rename")?.ownerKey).toBe("user:profile-account-a");
  expect(resumed.ok).toBe(true);
  expect(handle).toHaveBeenCalledWith("continue");
});

it("rejects pending GitHub ownership and binds only the attached canonical profile", async () => {
  const pendingClient = makeClient({
    connId: "conn-pending",
    deviceId: "device-pending",
    authenticatedUserId: "released-login@github",
    githubSyncPending: true,
  });

  const pending = await callChat(context, { sessionId: "github-pending" }, pendingClient);
  expect(pending).toMatchObject({ ok: false, error: { code: "UNAVAILABLE", retryable: true } });
  expect(sessions.has("github-pending")).toBe(false);

  pendingClient.authenticatedUserProfile = {
    profileId: "profile-canonical",
    displayName: null,
    hasAvatar: false,
    updatedAt: 2,
  };
  const attached = await callChat(context, { sessionId: "github-pending" }, pendingClient);

  expect(attached.ok).toBe(true);
  expect(sessions.get("github-pending")?.ownerKey).toBe("user:profile-canonical");
});

it("rejects non-delegated chat without a server-authenticated identity", async () => {
  const call = await callChat(context, { sessionId: "anonymous" }, null);

  expect(call).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
});

it("keeps explicit delegation authoritative across connection identities", async () => {
  const delegation = { agentId: "main", sessionKey: "agent:main:main" };
  await callChat(
    context,
    { sessionId: "delegated", delegation },
    makeClient({ connId: "conn-owner", deviceId: "device-owner" }),
  );
  expect(inferenceFallbackMocks.verifySystemAgentInferenceWithFallback).toHaveBeenCalledWith({
    requestingAgentId: "main",
    runtime: expect.anything(),
  });
  expect(createdEngineOptions[0]).toMatchObject({
    operatorApprovalOnly: true,
    requesterAgentId: "main",
    surface: "gateway",
  });
  const handle = expectDefined(createdEngines[0], "created delegated engine").handle;

  const caller = {
    ...delegation,
    operationalRunInstance: createOperationalRunInstanceRef("delegated-ownership-run"),
  };
  const authority = claimAgentRunDelegatedAuthority(caller.operationalRunInstance);
  const resume = () =>
    withGatewayToolCallerIdentity(caller, () =>
      callChat(
        context,
        { sessionId: "delegated", message: "continue", delegation },
        makeClient({
          connId: "conn-other",
          deviceId: "device-other",
          authenticatedUserId: "other@example.com",
        }),
      ),
    );
  try {
    expect((await resume()).ok).toBe(true);
    expect(handle).toHaveBeenCalledWith("continue");
    expect(inferenceFallbackMocks.verifySystemAgentInferenceWithFallback).toHaveBeenCalledOnce();
  } finally {
    releaseAgentRunDelegatedAuthority(authority);
  }
  await expect(resume()).rejects.toThrow("requires an active run authority");
  expect(handle).toHaveBeenCalledOnce();
});

it("rejects delegated reuse of a non-delegated session", async () => {
  const engine = makeEngine();
  sessions.set("shared", seededSession(engine));

  const delegated = await callChat(context, {
    sessionId: "shared",
    message: "yes",
    delegation: { agentId: "main", sessionKey: "agent:main:main" },
  });

  expect(delegated).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  expect(engine.handle).not.toHaveBeenCalled();
});

it("returns the stored welcome when no message is sent", async () => {
  const call = await callChat(sessionContext(), { sessionId: "s1" });

  expect(call).toMatchObject({
    ok: true,
    payload: { sessionId: "s1", reply: "welcome text", action: "none" },
  });
});

it.each([
  { wizardAnswer: { stepId: "channel", value: "twitch" } },
  { wizardCancel: { stepId: "channel" } },
])("rejects a structured wizard request without an active session: %j", async (request) => {
  expectInvalid(await callChat(context, { sessionId: "missing", ...request }), true);
  expect(inferenceFallbackMocks.verifySystemAgentInferenceWithFallback).not.toHaveBeenCalled();
});

it("routes a structured cancel through its bound session", async () => {
  const engine = makeEngine();
  engine.cancelWizard.mockResolvedValue({ text: "Setup cancelled.", action: "none" });

  const call = await callChat(sessionContext(engine), {
    sessionId: "s1",
    wizardCancel: { stepId: "channel" },
  });

  expect(engine.cancelWizard).toHaveBeenCalledWith({ stepId: "channel" });
  expect(call.payload).toMatchObject({ reply: "Setup cancelled.", action: "none" });
});

it("rejects a structured answer when the active session has no hosted wizard", async () => {
  const engine = makeEngine();

  const call = await callChat(sessionContext(engine), {
    sessionId: "s1",
    wizardAnswer: { stepId: "stale", value: "twitch" },
  });

  expect(call).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  expect(transcriptStoreMocks.appendTurn).not.toHaveBeenCalled();
});

it.each([
  {
    label: "sensitive input",
    message: "yes",
    reply: { text: "Enter the bot token", action: "none", sensitive: true },
    expected: { sensitive: true },
    noDraft: false,
  },
  {
    label: "default TUI handoff",
    message: "talk to agent",
    reply: { text: "", action: "open-tui", handoff: { kind: "open-tui" } },
    expected: {
      action: "open-agent",
      reply: expect.stringContaining("continue with your agent"),
    },
    noDraft: true,
  },
  {
    label: "hatch draft",
    message: "yes",
    reply: {
      text: "Your agent is hatching.",
      action: "open-tui",
      agentDraft: "hatch",
      handoff: { kind: "open-tui", agentId: "researcher" },
    },
    expected: { action: "open-agent", agentDraft: "hatch", agentId: "researcher" },
    noDraft: false,
  },
] satisfies Array<{
  label: string;
  message: string;
  reply: Awaited<ReturnType<SystemAgentChatSession["engine"]["handle"]>>;
  expected: object;
  noDraft: boolean;
}>)("projects $label", async ({ message, reply, expected, noDraft }) => {
  const engine = makeEngine();
  engine.handle.mockResolvedValue(reply);
  const call = await callChat(sessionContext(engine), { sessionId: "s1", message });
  expect(call.payload).toMatchObject(expected);
  if (noDraft) {
    expect(call.payload).not.toHaveProperty("agentDraft");
  }
});
