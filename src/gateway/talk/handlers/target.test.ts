import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { GatewayOperatorRoleDefinition } from "../../../config/types.gateway.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { prepareUserProfileCatalog } from "../../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import * as clientVoiceSession from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "../../server-methods.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "../../server-methods/types.js";
import { sharingPolicyClient } from "../../session-sharing.test-utils.js";
import { closeTalkClientGatewayControlSession } from "../client-gateway-control.js";
import { cleanupTalkConnection } from "../session-registry.js";
import { createTalkClient } from "./client-create.js";
import { talkClientHandlers } from "./client.js";
import { talkSessionHandlers } from "./session.js";

const mocks = vi.hoisted(() => ({
  resolveConfiguredRealtimeVoiceProviderAsync: vi.fn(),
  bootstrap: vi.fn(async () => "Agent context fixture."),
  createRelay: vi.fn(() => ({
    relaySessionId: "test-relay",
    provider: "test-voice",
    transport: "gateway-relay",
  })),
  createTranscription: vi.fn(() => ({ transcriptionSessionId: "test-dictation" })),
  transcriptionProviders: vi.fn(() => []),
}));

// mock-isolation: Keep provider registration and credential state outside handler tests.
vi.mock("../../../talk/provider-resolver.js", () => ({
  resolveConfiguredRealtimeVoiceProviderAsync: mocks.resolveConfiguredRealtimeVoiceProviderAsync,
}));
vi.mock("../../../talk/provider-registry.js", () => ({ listRealtimeVoiceProviders: () => [] }));
vi.mock("../../../agents/realtime-bootstrap-context.js", () => ({
  resolveRealtimeVoiceAgentContextInstructions: mocks.bootstrap,
}));
vi.mock("../relay/session-create.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../relay/session-create.js")>()),
  createTalkRealtimeRelaySession: mocks.createRelay,
}));
vi.mock("../transcription-relay.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../transcription-relay.js")>()),
  createTalkTranscriptionRelaySession: mocks.createTranscription,
}));
vi.mock("../../../realtime-transcription/provider-registry.js", () => ({
  listRealtimeTranscriptionProviders: mocks.transcriptionProviders,
  getRealtimeTranscriptionProvider: () => undefined,
}));

const createParams = {
  mode: "realtime",
  transport: "webrtc",
  brain: "agent-consult",
  silenceDurationMs: 400,
  capabilities: ["gateway-control-v1"],
};

const browserSession = {
  provider: "test-voice",
  transport: "webrtc" as const,
  clientSecret: "synthetic-offer-token",
  offerUrl: "/test/voice/offer",
};
const voiceScope = { agentId: "voice", sessionKey: "agent:voice:main" };
const otherCreator = { type: "human", source: "profile", id: "another-person" } as const;

function writeSession(
  sessionId: string,
  overrides: Partial<Parameters<typeof replaceSessionEntry>[1]> = {},
  scope: Parameters<typeof replaceSessionEntry>[0] = voiceScope,
) {
  return replaceSessionEntry(scope, {
    sessionId,
    updatedAt: 1,
    createdActor: otherCreator,
    ...overrides,
  });
}

function setConfig(overrides: Partial<OpenClawConfig>) {
  config = { ...config, ...overrides };
  setRuntimeConfigSnapshot(config);
}

function setRole(role: Omit<GatewayOperatorRoleDefinition, "scopes">, name = "limited") {
  config.gateway = {
    roles: {
      default: name,
      definitions: { [name]: { scopes: ["operator.read", "operator.write"], ...role } },
    },
  };
}

function expectNoProviderSetup() {
  expect(createBrowserSession).not.toHaveBeenCalled();
  expect(mocks.bootstrap).not.toHaveBeenCalled();
}

function expectNoMainSessions() {
  for (const agentId of ["voice", "primary"]) {
    expect(loadSessionEntry({ agentId, sessionKey: `agent:${agentId}:main` })).toBeUndefined();
  }
}

const createClient = (params: Record<string, unknown> = {}, handlers?: GatewayRequestHandlers) =>
  dispatch("talk.client.create", { ...createParams, ...params }, handlers);

function expectRejected(respond: ReturnType<typeof vi.fn>, code = "INVALID_REQUEST") {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code }));
}

function expectCreated(
  respond: ReturnType<typeof vi.fn>,
  result: unknown = expect.objectContaining(browserSession),
) {
  expect(respond).toHaveBeenCalledWith(true, result, undefined);
}

let state: OpenClawTestState;
let releaseProfileCatalog: (() => void) | undefined;
let config: OpenClawConfig;
let client: ReturnType<typeof sharingPolicyClient> & { connId: string };
const createBrowserSession = vi.fn<
  NonNullable<RealtimeVoiceProviderPlugin["createBrowserSession"]>
>(async () => browserSession);
const createdCalls: Array<{ sessionKey: string; voiceSessionId: string }> = [];
const cancelBrowserSession = vi.fn(async () => undefined);
const context = {
  getRuntimeConfig: () => config,
  getClientConnIds: () => new Set([client.connId]),
  logGateway: { warn: vi.fn() },
  broadcastToConnIds: vi.fn(),
} as unknown as GatewayRequestContext;

async function dispatch(
  method: string,
  params: Record<string, unknown>,
  handlers: GatewayRequestHandlers = {},
) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: "talk-request", method, params },
    client,
    context,
    isWebchatConnect: () => false,
    respond,
    extraHandlers: { ...talkClientHandlers, ...talkSessionHandlers, ...handlers },
  });
  if (method === "talk.client.create" && respond.mock.calls[0]?.[0] === true) {
    const { voiceSessionId } = respond.mock.calls[0][1] as { voiceSessionId: string };
    const record = ["voice", "primary"]
      .map((agentId) => clientVoiceSessionTesting.readRecord(agentId, voiceSessionId))
      .find(Boolean);
    if (record) {
      createdCalls.push({ sessionKey: record.sessionKey, voiceSessionId });
    }
  }
  return respond;
}

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "talk-target", prepareProfileCatalog: true });
  client = {
    ...sharingPolicyClient({ user: ensureProfileForEmail("listener@example.test").id }),
    connId: "talk-target-test",
  };
  releaseProfileCatalog = (await prepareUserProfileCatalog()).release;
  config = {
    agents: { ownership: "explicit", entries: { primary: {}, voice: {} } },
    talk: { agentId: "voice" },
  };
  setRuntimeConfigSnapshot(config);
  vi.clearAllMocks();
  createdCalls.length = 0;
  createBrowserSession.mockReset().mockResolvedValue(browserSession);
  mocks.bootstrap.mockReset().mockResolvedValue("Agent context fixture.");
  setActivePluginRegistry(createEmptyPluginRegistry());
  const provider = {
    id: "test-voice",
    capabilities: { supportsGatewayControl: true, supportsToolCalls: true },
    createBrowserSession,
  };
  Object.defineProperty(provider, Symbol.for("openclaw.internal.realtime-voice-provider.v1"), {
    value: { isBrowserSessionConfigured: () => true, cancelBrowserSession },
  });
  mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
    provider,
    providerConfig: {},
    capabilities: provider.capabilities,
  });
});

afterEach(async () => {
  try {
    for (const call of createdCalls) {
      await closeTalkClientGatewayControlSession({ ...call, connId: client.connId });
    }
    cleanupTalkConnection(client.connId, context.logGateway);
  } finally {
    vi.restoreAllMocks();
    clientVoiceSessionTesting.reset();
    setActivePluginRegistry(createEmptyPluginRegistry());
    releaseProfileCatalog?.();
    releaseProfileCatalog = undefined;
    await state.cleanup();
  }
});

it("uses the configured Talk owner for main", async () => {
  const respond = await createClient({ sessionKey: "main" });
  expectCreated(respond);
  expect(createBrowserSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: "voice" }));
  expect(loadSessionEntry(voiceScope)?.sessionId).toBeTruthy();
});

it.each(["read-only", "draft", "incognito"] as const)(
  "applies %s restrictions to bare and omitted create targets",
  async (restriction) => {
    await writeSession(
      "private-session",
      restriction === "incognito" ? { incognito: true } : { visibility: restriction },
    );
    for (const method of ["talk.client.create", "talk.session.create"]) {
      for (const sessionKey of ["main", undefined]) {
        const respond = await dispatch(method, {
          mode: "realtime",
          brain: "agent-consult",
          transport: method === "talk.client.create" ? "webrtc" : "gateway-relay",
          ...(sessionKey ? { sessionKey } : {}),
        });
        expectRejected(respond);
      }
    }
    expectNoProviderSetup();
    expect(mocks.createRelay).not.toHaveBeenCalled();
  },
);

it("creates Talk in its custom suffixed store without adopting an unsuffixed decoy", async () => {
  config.session = { store: state.statePath("shared.json") };
  config.agents!.defaults = { sessionStore: { agentId: "primary" } };
  const unsuffixed = openOpenClawAgentDatabase({
    agentId: "main",
    path: state.statePath("shared.sqlite"),
  });
  const selected = openOpenClawAgentDatabase({
    agentId: "primary",
    path: state.statePath("shared.primary.sqlite"),
  });
  const scope = { agentId: "primary", sessionKey: "agent:primary:main" };
  await replaceSessionEntry(
    { ...scope, storePath: unsuffixed.path },
    {
      sessionId: "unsuffixed-decoy",
      updatedAt: 1,
    },
  );
  expect(loadSessionEntry({ ...scope, storePath: selected.path })).toBeUndefined();
  const respond = await createClient({ sessionKey: scope.sessionKey });
  expectCreated(respond);
  const createdSessionId = loadSessionEntry({ ...scope, storePath: selected.path })?.sessionId;
  expect(createdSessionId).toBeTruthy();
  expect(createdSessionId).not.toBe("unsuffixed-decoy");
  expect(loadSessionEntry({ ...scope, storePath: unsuffixed.path })?.sessionId).toBe(
    "unsuffixed-decoy",
  );
});

it("shares the global fixed-store target while retaining the exact voice key", async () => {
  const agentId = "primary";
  const voiceKey = "main";
  config.session = {
    scope: "global",
    store: state.statePath("shared", "sessions.sqlite"),
  };
  config.agents!.defaults = { sessionStore: { agentId } };
  const params = Object.freeze({ ...createParams, sessionKey: voiceKey });
  const respond = await dispatch("talk.client.create", params);
  expectCreated(respond);
  const { voiceSessionId } = respond.mock.calls[0]![1] as { voiceSessionId: string };
  expect(clientVoiceSessionTesting.readRecord(agentId, voiceSessionId)?.sessionKey).toBe(voiceKey);
  const scope = { agentId, sessionKey: "global", storePath: config.session.store };
  const stored = loadSessionEntry(scope);
  expect(stored?.sessionId).toBeTruthy();
  expect(mocks.bootstrap).toHaveBeenCalledWith(
    expect.objectContaining({ agentId, sessionKey: "global" }),
  );
  expectCreated(
    await dispatch("talk.client.transcript", {
      sessionKey: voiceKey,
      voiceSessionId,
      entryId: "utterance",
      role: "user",
      text: "Synthetic speech",
    }),
    { ok: true },
  );
  expect(
    readSessionTranscriptMessageEvents({ ...scope, sessionId: stored!.sessionId }),
  ).toHaveLength(1);
  expectRejected(await dispatch("talk.client.close", { sessionKey: "global", voiceSessionId }));
  expectCreated(await dispatch("talk.client.close", { sessionKey: voiceKey, voiceSessionId }), {
    ok: true,
  });
});

it.each([
  { name: "missing key", params: { voiceSessionId: "relay-call" } },
  { name: "missing voice id", params: { sessionKey: "main" } },
  { name: "relay origin", params: { sessionKey: "main", voiceSessionId: "relay-call" } },
])("rejects a client close with $name without changing the voice record", async ({ params }) => {
  await clientVoiceSession.createOrResumeClientVoiceSession({
    agentId: "voice",
    sessionKey: "main",
    voiceSessionId: "relay-call",
    origin: "relay",
  });
  expectRejected(await dispatch("talk.client.close", params));
  expect(clientVoiceSessionTesting.readRecord("voice", "relay-call")?.status).toBe("open");
});

it.each(["primary", "retired"])(
  "rejects a global key conflicting with fixed-store owner %s",
  async (owner) => {
    config.session = { scope: "global", store: state.statePath("shared", "sessions.sqlite") };
    config.agents!.defaults = { sessionStore: { agentId: owner } };
    const respond = await createClient({ sessionKey: "agent:voice:main" });
    expectRejected(respond);
    expectNoProviderSetup();
  },
);

it.each(["owner", "removed-agent", "sharing", "incognito"] as const)(
  "rejects %s changes during provider creation without writing a different target",
  async (change) => {
    const gate = createDeferredCore<typeof browserSession>();
    const started = createDeferredCore();
    createBrowserSession.mockImplementationOnce(async () => {
      started.resolve();
      return await gate.promise;
    });
    const pending = createClient({ sessionKey: "main" });
    await started.promise;
    if (change === "removed-agent") {
      setConfig({ agents: { ownership: "explicit", entries: { primary: {} } } });
    } else if (change === "owner") {
      setConfig({ talk: { agentId: "primary" } });
    } else {
      await replaceSessionEntry(voiceScope, {
        sessionId: "concurrent-session",
        updatedAt: 1,
        ...(change === "incognito" ? { incognito: true } : { visibility: "read-only" as const }),
      });
    }
    gate.resolve(browserSession);
    const respond = await pending;
    expectRejected(respond);
    expect(cancelBrowserSession).toHaveBeenCalledOnce();
    expect(
      loadSessionEntry({ agentId: "primary", sessionKey: "agent:primary:main" }),
    ).toBeUndefined();
    expect(
      loadSessionEntry({ agentId: "voice", sessionKey: "agent:voice:changed" }),
    ).toBeUndefined();
    if (change !== "sharing" && change !== "incognito") {
      expect(loadSessionEntry(voiceScope)).toBeUndefined();
    }
  },
);

it.each(["agent", "hidden", "sandbox"] as const)(
  "enforces the %s role boundary on an omitted target",
  async (restriction) => {
    setRole({
      agents: restriction === "agent" ? ["primary"] : "*",
      sessions: { others: restriction === "hidden" ? "none" : "write" },
      ...(restriction === "sandbox" ? { sandbox: "required" } : {}),
    });
    if (restriction !== "agent") {
      await writeSession("host-session", { visibility: "shared" });
    }
    const respond = await createClient();
    expectRejected(respond, restriction === "hidden" ? "INVALID_REQUEST" : "FORBIDDEN");
    expectNoProviderSetup();
  },
);

it.each(["lazy handler dispatch", "profile preparation"])(
  "does not retarget during %s",
  async (phase) => {
    const gate = createDeferredCore();
    const started = createDeferredCore();
    const wait = async () => {
      started.resolve();
      await gate.promise;
    };
    if (phase === "profile preparation") {
      mocks.bootstrap.mockImplementationOnce(async () => {
        await wait();
        return "Agent context fixture.";
      });
    }
    const pending = createClient(
      {},
      {
        "talk.client.create": async (request) => {
          if (phase === "lazy handler dispatch") {
            await wait();
          }
          return createTalkClient(request);
        },
      },
    );
    await started.promise;
    setConfig({ talk: { agentId: "primary" } });
    gate.resolve();
    expectRejected(await pending);
    expectNoMainSessions();
  },
);

it("passes the authorized omitted target into relay creation", async () => {
  config.session = { scope: "global" };
  const respond = await dispatch("talk.session.create", {
    mode: "realtime",
    transport: "gateway-relay",
    brain: "agent-consult",
  });
  expectCreated(respond, expect.objectContaining({ sessionId: "test-relay" }));
  expect(mocks.createRelay).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionTarget: expect.objectContaining({
        agentId: "voice",
        canonicalKey: "global",
        sessionKey: voiceScope.sessionKey,
      }),
    }),
  );
  expect(loadSessionEntry({ agentId: "voice", sessionKey: "global" })?.sessionId).toBeTruthy();
});

it("keeps keyless transcription independent of Talk agent selection", async () => {
  delete config.talk;
  mocks.transcriptionProviders.mockReturnValue([
    { id: "test-transcription", isConfigured: () => true },
  ] as never);
  const respond = await dispatch("talk.session.create", {
    mode: "transcription",
    transport: "gateway-relay",
    brain: "none",
  });
  expectCreated(respond, expect.objectContaining({ sessionId: "test-dictation" }));
  expectNoProviderSetup();
  expect(loadSessionEntry(voiceScope)).toBeUndefined();
});

it.each(["sharing", "incognito", "replacement", "owner"] as const)(
  "rechecks %s after session preparation and before committing the voice call",
  async (change) => {
    if (change === "sharing") {
      await writeSession("existing-shared-session", { visibility: "shared" });
    }
    const createVoice = clientVoiceSession.createOrResumeClientVoiceSession;
    let changedBeforeVoiceCommit = false;
    vi.spyOn(clientVoiceSession, "createOrResumeClientVoiceSession").mockImplementationOnce(
      async (params) => {
        const scope = {
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          storePath: params.source?.storePath,
        };
        const sessionId = loadSessionEntry(scope)?.sessionId;
        expect(sessionId).toBeTruthy();
        if (change === "owner") {
          setConfig({ talk: { agentId: "primary" } });
        } else {
          await writeSession(
            change === "replacement" ? "replacement-session" : sessionId!,
            {
              updatedAt: 2,
              ...(change === "incognito" ? { incognito: true } : { visibility: "read-only" }),
            },
            scope,
          );
        }
        changedBeforeVoiceCommit = true;
        return createVoice(params);
      },
    );
    const respond = await createClient({ voiceSessionId: "provisional" });
    expect(changedBeforeVoiceCommit).toBe(true);
    expectRejected(respond);
    expect(clientVoiceSessionTesting.readRecord("voice", "provisional")).toBeUndefined();
    expect(cancelBrowserSession).toHaveBeenCalledOnce();
  },
);

it("retains the identified creator when a restricted role creates its first Talk session", async () => {
  setRole({ agents: ["voice"], sessions: { others: "none" } }, "personal");
  expectCreated(await createClient());
  expect(loadSessionEntry(voiceScope)?.createdActor).toEqual({
    type: "human",
    source: "profile",
    id: client.authenticatedUserProfile?.profileId,
  });
});
