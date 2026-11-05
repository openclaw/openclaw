import path from "node:path";
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindTestChannelParticipantAdmissionEvidence } from "../../../test/helpers/channel-admission-evidence.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { AcpInitializeSessionInput } from "../../acp/control-plane/manager.js";
import { AcpRuntimeError } from "../../acp/runtime/errors.js";
import { configureExecutionIdentityAdmissionSink } from "../../audit/execution-identity-admission.js";
import { createChannelAdmissionAudit } from "../../channels/message-access/admission-evidence.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import type { SessionBindingBindInput } from "../../infra/outbound/session-binding.types.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { expectObjectFields, mockFirstObjectArg } from "../../test-utils/mock-call-assertions.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { MsgContext } from "../templating.js";
import { setMinimalAcpCommandRegistryForTests } from "./commands-acp.channels.test-support.js";
import {
  createAcpCommandSessionBindingService,
  createAcpTestObservabilitySnapshot,
  createAcpTestSessionBinding as createSessionBinding,
} from "./test-fixtures/acp-runtime.js";

const hoisted = vi.hoisted(() => ({
  readAcpSessionEntryMock: vi.fn(),
  readAcpSessionEntryAsyncMock:
    vi.fn<typeof import("../../acp/runtime/session-meta.js").readAcpSessionEntryAsync>(),
  callGatewayMock: vi.fn(),
  cleanupFailedAcpSpawnMock: vi.fn(),
  closeRuntimeOnFailureMock: vi.fn(),
  requireAcpRuntimeBackendMock: vi.fn(),
  getAcpRuntimeBackendMock: vi.fn(),
  listAcpSessionEntriesMock: vi.fn(),
  upsertAcpSessionMetaMock: vi.fn(),
  resolveSessionStorePathForAcpMock: vi.fn(),
  sessionBindingCapabilitiesMock: vi.fn(),
  sessionBindingBindMock: vi.fn(),
  sessionBindingListBySessionMock: vi.fn(),
  sessionBindingResolveByConversationMock: vi.fn(),
  sessionBindingUnbindMock: vi.fn(),
  ensureSessionMock: vi.fn<AcpRuntime["ensureSession"]>(),
  initializeSessionMock: vi.fn<InstanceType<typeof AcpSessionManager>["initializeSession"]>(),
  runTurnMock: vi.fn(),
  cancelMock: vi.fn(),
  closeMock: vi.fn(),
  getStatusMock: vi.fn(),
  setModeMock: vi.fn(),
  setConfigOptionMock: vi.fn(),
  updateSessionRuntimeOptionsMock: vi.fn(),
  updateSessionEntryMock:
    vi.fn<typeof import("../../config/sessions/session-accessor.js").updateSessionEntry>(),
}));

// mock-isolation: Spawn cleanup belongs to the fixture lifecycle, not a live ACP runtime.
vi.mock("../../acp/control-plane/spawn.js", () => ({
  cleanupFailedAcpSpawn: hoisted.cleanupFailedAcpSpawnMock,
}));

// mock-isolation: Command tests use a fixture transport and must not open a live Gateway connection.
vi.mock("../../gateway/call.js", () => ({
  callGateway: hoisted.callGatewayMock,
}));

// mock-isolation: Resolve only the fixture backend, not the process-global runtime registry.
vi.mock("../../acp/runtime/registry.js", () => ({
  requireAcpRuntimeBackend: hoisted.requireAcpRuntimeBackendMock,
  getAcpRuntimeBackend: hoisted.getAcpRuntimeBackendMock,
}));

vi.mock("../../acp/runtime/session-meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../acp/runtime/session-meta.js")>()),
  listAcpSessionEntries: hoisted.listAcpSessionEntriesMock,
  readAcpSessionEntry: hoisted.readAcpSessionEntryMock,
  readAcpSessionEntryAsync: hoisted.readAcpSessionEntryAsyncMock,
  upsertAcpSessionMeta: hoisted.upsertAcpSessionMetaMock,
  resolveSessionStorePathForAcp: hoisted.resolveSessionStorePathForAcpMock,
}));

vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-accessor.js")>()),
  updateSessionEntry: hoisted.updateSessionEntryMock,
}));

vi.mock("../../infra/outbound/session-binding-service.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../infra/outbound/session-binding-service.js")
  >("../../infra/outbound/session-binding-service.js");
  return {
    ...actual,
    getSessionBindingService: () =>
      createAcpCommandSessionBindingService({
        bind: hoisted.sessionBindingBindMock,
        getCapabilities: hoisted.sessionBindingCapabilitiesMock,
        listBySession: hoisted.sessionBindingListBySessionMock,
        resolveByConversation: hoisted.sessionBindingResolveByConversationMock,
        unbind: hoisted.sessionBindingUnbindMock,
      }),
    listSessionBindingsBySessionsAsync: async (keys: readonly string[]) =>
      new Map(keys.map((key) => [key, hoisted.sessionBindingListBySessionMock(key)])),
  } satisfies typeof actual;
});

const { handleAcpCommand } = await import("./commands-acp.js");
const { buildCommandTestParams } = await import("./commands-spawn.test-harness.js");
const { AcpSessionManager, testing: acpManagerTesting } =
  await import("../../acp/control-plane/manager.js");
const { resolveEffectiveResetTargetSessionKey } = await import("./acp-reset-target.js");

const baseCfg = {
  acp: { enabled: true, dispatch: { enabled: true }, backend: "acpx" },
  session: {
    mainKey: "main",
    scope: "per-sender",
    threadBindings: { enabled: true, spawnSessions: true },
  },
} satisfies OpenClawConfig;

function createParams(
  commandBody: string,
  cfg: OpenClawConfig = baseCfg,
  ctx: Partial<MsgContext> = {},
) {
  const channel = ctx.Provider ?? "discord";
  const params = buildCommandTestParams(commandBody, cfg, {
    Provider: channel,
    Surface: channel,
    OriginatingChannel: channel,
    OriginatingTo: "channel:parent-1",
    AccountId: "default",
    ...ctx,
  });
  params.command.senderId = ctx.SenderId ?? "user-1";
  params.command.senderIsOwner = true;
  return params;
}

const defaultAcpSessionKey = "agent:codex:acp:s1";
const defaultThreadId = "thread-1";

function createAcpMeta(overrides: Partial<SessionAcpMeta> = {}): SessionAcpMeta {
  return {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "runtime-1",
    mode: "persistent",
    state: "idle",
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

const runtimeBackend = {
  id: "acpx",
  runtime: {
    ensureSession: hoisted.ensureSessionMock,
    runTurn: hoisted.runTurnMock,
    cancel: hoisted.cancelMock,
    close: hoisted.closeMock,
  },
};

function initializedSession({ sessionKey, agent, mode, cwd }: AcpInitializeSessionInput) {
  const meta = createAcpMeta({
    agent,
    mode,
    runtimeSessionName: `${sessionKey}:runtime`,
    ...(cwd ? { cwd, runtimeOptions: { cwd } } : {}),
  });
  return {
    sessionEntry: { sessionId: "session-1", updatedAt: Date.now(), acp: meta },
    closeRuntimeOnFailure: hoisted.closeRuntimeOnFailureMock,
    runtime: runtimeBackend.runtime,
    handle: { sessionKey, backend: meta.backend, runtimeSessionName: meta.runtimeSessionName },
    meta,
  };
}

function readTestAcpMeta(sessionKey: string): SessionAcpMeta {
  return (
    hoisted.readAcpSessionEntryMock({ sessionKey })?.acp ??
    createAcpMeta({ runtimeSessionName: `${sessionKey}:runtime` })
  );
}

function createBoundThreadSession(sessionKey: string = defaultAcpSessionKey) {
  return createSessionBinding({
    targetSessionKey: sessionKey,
    conversation: {
      channel: "discord",
      accountId: "default",
      conversationId: defaultThreadId,
      parentConversationId: "parent-1",
    },
  });
}

function createAcpSessionEntry(options?: { sessionKey?: string; acp?: Partial<SessionAcpMeta> }) {
  const sessionKey = options?.sessionKey ?? defaultAcpSessionKey;
  return {
    sessionKey,
    storeSessionKey: sessionKey,
    entry: { sessionId: "sess-acp", updatedAt: Date.now(), label: "codex-main" },
    acp: createAcpMeta(options?.acp),
  };
}

function createAcpThreadBinding(input: SessionBindingBindInput) {
  return createSessionBinding({
    targetSessionKey: input.targetSessionKey,
    conversation: {
      ...input.conversation,
      ...(input.placement === "child"
        ? {
            conversationId: "thread-created",
            parentConversationId: input.conversation.conversationId,
          }
        : {}),
    },
  });
}

function expectMockCallFields(
  mock: unknown,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  return expectObjectFields(mockFirstObjectArg(mock), expected);
}

function expectBindingBindCall(expected: {
  conversation?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  placement?: "current" | "child";
  targetKind?: "session";
}): Record<string, unknown> {
  const input = mockFirstObjectArg(hoisted.sessionBindingBindMock);
  expect(input).toMatchObject(expected);
  return input;
}

function expectGatewayMethodNotCalled(method: string): void {
  expect(hoisted.callGatewayMock).not.toHaveBeenCalledWith(expect.objectContaining({ method }));
}

function expectReplyText(result: Awaited<ReturnType<typeof handleAcpCommand>>, ...parts: string[]) {
  for (const part of parts) {
    expect(result?.reply?.text).toContain(part);
  }
}

function mockBoundThreadSession(options?: Parameters<typeof createAcpSessionEntry>[0]) {
  const sessionKey = options?.sessionKey ?? defaultAcpSessionKey;
  hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
    createBoundThreadSession(sessionKey),
  );
  hoisted.readAcpSessionEntryMock.mockReturnValue(
    createAcpSessionEntry({ ...options, sessionKey }),
  );
}

async function runCommand(
  commandBody: string,
  cfg: OpenClawConfig = baseCfg,
  ctx: Partial<MsgContext> = {},
) {
  return handleAcpCommand(createParams(commandBody, cfg, ctx), true);
}

async function runThreadAcpCommand(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  return runCommand(commandBody, cfg, { MessageThreadId: defaultThreadId });
}

function mockGatewaySessionResolution(key: string | null) {
  hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) =>
    request.method === "sessions.resolve" ? (key === null ? null : { key }) : { ok: true },
  );
}

describe("/acp command", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  beforeEach(() => {
    setMinimalAcpCommandRegistryForTests();
    acpManagerTesting.resetAcpSessionManagerForTests();
    for (const mock of Object.values(hoisted)) {
      mock.mockReset();
    }
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([]);
    hoisted.callGatewayMock.mockResolvedValue({ ok: true });
    hoisted.cleanupFailedAcpSpawnMock.mockResolvedValue(undefined);
    hoisted.closeRuntimeOnFailureMock.mockResolvedValue(undefined);
    hoisted.readAcpSessionEntryMock.mockReturnValue(null);
    hoisted.readAcpSessionEntryAsyncMock.mockImplementation(async (input) =>
      hoisted.readAcpSessionEntryMock(input),
    );
    hoisted.resolveSessionStorePathForAcpMock.mockReturnValue({
      cfg: baseCfg,
      storePath: "/tmp/sessions-acp.json",
    });
    hoisted.updateSessionEntryMock.mockResolvedValue(null);
    hoisted.sessionBindingCapabilitiesMock.mockReturnValue({
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current", "child"],
    });
    hoisted.sessionBindingBindMock.mockImplementation(async (input: SessionBindingBindInput) =>
      createAcpThreadBinding(input),
    );
    hoisted.sessionBindingListBySessionMock.mockReturnValue([]);
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(null);
    hoisted.sessionBindingUnbindMock.mockResolvedValue([]);

    hoisted.ensureSessionMock.mockImplementation(async (input: { sessionKey: string }) => ({
      sessionKey: input.sessionKey,
      backend: "acpx",
      runtimeSessionName: `${input.sessionKey}:runtime`,
    }));
    hoisted.runTurnMock.mockImplementation(async function* () {
      yield { type: "done" };
    });
    hoisted.cancelMock.mockResolvedValue(undefined);
    hoisted.closeMock.mockResolvedValue({ runtimeClosed: true, metaCleared: true });
    hoisted.getStatusMock.mockResolvedValue({
      summary: "status=alive sessionId=sid-1 pid=1234",
      details: { status: "alive", sessionId: "sid-1", pid: 1234 },
    });
    hoisted.setModeMock.mockResolvedValue(undefined);
    hoisted.setConfigOptionMock.mockResolvedValue(undefined);
    hoisted.updateSessionRuntimeOptionsMock.mockResolvedValue(undefined);

    hoisted.requireAcpRuntimeBackendMock.mockReturnValue(runtimeBackend);
    hoisted.getAcpRuntimeBackendMock.mockReturnValue(runtimeBackend);
    hoisted.initializeSessionMock.mockImplementation(async (input) => initializedSession(input));
    acpManagerTesting.setAcpSessionManagerForTests({
      initializeSession: hoisted.initializeSessionMock,
      resolveSessionAsync: async ({ sessionKey }: { sessionKey: string }) => ({
        kind: "ready" as const,
        sessionKey,
        meta: readTestAcpMeta(sessionKey),
      }),
      cancelSession: hoisted.cancelMock,
      getSessionStatus: async (input: { sessionKey: string }) => {
        const status = await hoisted.getStatusMock(input);
        const meta = readTestAcpMeta(input.sessionKey);
        return {
          ...meta,
          sessionKey: input.sessionKey,
          runtimeOptions: meta.runtimeOptions ?? {},
          capabilities: {
            controls: ["session/set_mode", "session/set_config_option", "session/status"],
          },
          runtimeStatus: status,
        };
      },
      getObservabilitySnapshot: createAcpTestObservabilitySnapshot,
      runTurn: async (input: { onEvent?: (event: unknown) => Promise<void> | void }) => {
        for await (const event of hoisted.runTurnMock(input) as AsyncIterable<unknown>) {
          await input.onEvent?.(event);
        }
      },
      setSessionRuntimeMode: async (input: { sessionKey: string; runtimeMode: string }) =>
        (await hoisted.setModeMock(input)) ?? { runtimeMode: input.runtimeMode },
      setSessionConfigOption: async (input: { key: string; value: string }) =>
        (await hoisted.setConfigOptionMock(input)) ?? { [input.key]: input.value },
      updateSessionRuntimeOptions: async (input: { patch: Record<string, unknown> }) =>
        (await hoisted.updateSessionRuntimeOptionsMock(input)) ?? input.patch,
      closeSession: hoisted.closeMock,
    });
  });

  it.each(["/status", "/acp"])("routes %s without invoking an ACP action", async (command) => {
    const result = await runCommand(command);
    if (command === "/status") {
      expect(result).toBeNull();
    } else {
      expectReplyText(result, "ACP commands:", "/acp spawn");
    }
  });

  it("spawns a configured owner's workspace and binds a child thread", async () => {
    const workspace = tempDirs.make("openclaw-codex-");
    const cfg = { ...baseCfg, agents: { entries: { codex: { workspace } } } };
    const result = await runCommand("/acp spawn codex", cfg);
    expectReplyText(
      result,
      "Spawned ACP session agent:codex:acp:",
      "Created thread thread-created and bound it",
    );
    expectMockCallFields(hoisted.initializeSessionMock, {
      agent: "codex",
      mode: "persistent",
      cwd: workspace,
    });
    const binding = expectBindingBindCall({ targetKind: "session", placement: "child" });
    expect(binding.metadata).toMatchObject({
      introText: expect.stringContaining(`cwd: ${workspace}`),
    });
  });

  it("persists ACP spawn labels to the target store without a gateway self-call", async () => {
    const params = createParams("/acp spawn codex --bind here --label inbox");
    params.storePath = "/tmp/requester-sessions.json";
    hoisted.resolveSessionStorePathForAcpMock.mockReturnValue({
      cfg: baseCfg,
      storePath: "/tmp/main-sessions.json",
    });

    const result = await handleAcpCommand(params, true);

    expect(result?.reply?.text).toContain("Bound this conversation to");
    expectGatewayMethodNotCalled("sessions.patch");
    const spawnedSessionKey = mockFirstObjectArg(hoisted.initializeSessionMock).sessionKey;
    expect(spawnedSessionKey).toMatch(/^agent:main:acp:/);
    const updateCall = hoisted.updateSessionEntryMock.mock.calls[0];
    expect(updateCall?.[0]).toEqual({
      storePath: "/tmp/main-sessions.json",
      sessionKey: spawnedSessionKey,
    });
    expect(await updateCall?.[1]({ sessionId: "target", updatedAt: 1 })).toEqual({
      label: "inbox",
      updatedAt: expect.any(Number),
    });
  });

  it("accepts unicode dash option prefixes in /acp spawn args", async () => {
    const result = await runThreadAcpCommand(
      "/acp spawn codex \u2014mode oneshot \u2014thread here \u2014cwd /home/bob/clawd \u2014label jeerreview",
    );

    expectReplyText(result, "Spawned ACP session agent:main:acp:", "Bound this thread to");
    expectMockCallFields(hoisted.initializeSessionMock, {
      agent: "codex",
      mode: "oneshot",
      cwd: "/home/bob/clawd",
    });
    expectBindingBindCall({
      placement: "current",
      metadata: { label: "jeerreview" },
    });
  });

  it("keeps freshly spawned Slack-bound ACP metadata readable for the immediate follow-up", async () => {
    const directory = tempDirs.make("openclaw-acp-bound-followup-");
    const databasePath = path.join(directory, "state", "openclaw.sqlite");
    await withEnvAsync({ OPENCLAW_STATE_DIR: directory }, async () => {
      const cfg = {
        ...baseCfg,
        session: { ...baseCfg.session, store: path.join(directory, "sessions.json") },
      } satisfies OpenClawConfig;
      const sessionMeta = await vi.importActual<typeof import("../../acp/runtime/session-meta.js")>(
        "../../acp/runtime/session-meta.js",
      );
      const { createTestAdmittedRunContext } =
        await import("../../agents/admitted-run-context.test-support.js");
      const { closeOpenClawStateDatabaseByPathAsync } =
        await import("../../state/openclaw-state-db-cache.js");

      hoisted.upsertAcpSessionMetaMock.mockImplementation((input) =>
        sessionMeta.upsertAcpSessionMeta({ ...input, cfg, databasePath, now: () => 1 }),
      );
      hoisted.readAcpSessionEntryMock.mockImplementation((input) =>
        sessionMeta.readAcpSessionEntry({ ...input, cfg, databasePath }),
      );
      hoisted.readAcpSessionEntryAsyncMock.mockImplementation((input) =>
        sessionMeta.readAcpSessionEntryAsync({ ...input, cfg, databasePath }),
      );
      const manager = new AcpSessionManager();
      acpManagerTesting.setAcpSessionManagerForTests(manager);

      try {
        const result = await runCommand("/acp spawn codex --bind here", cfg, {
          Provider: "slack",
          OriginatingTo: "user:U123",
          SenderId: "U123",
        });
        expect(result?.reply?.text).toContain("Bound this conversation to");
        const binding = expectBindingBindCall({
          placement: "current",
          conversation: {
            channel: "slack",
            accountId: "default",
            conversationId: "user:U123",
          },
        });
        const requestId = "immediate-bound-followup";
        const sessionKey = binding.targetSessionKey;
        if (typeof sessionKey !== "string") {
          throw new Error("Expected the published binding to own an ACP session key");
        }

        await expect(
          manager.runTurn({
            admittedRunContext: createTestAdmittedRunContext(requestId),
            cfg,
            sessionKey,
            provenance: "human",
            text: "continue the bound ACP session",
            mode: "prompt",
            requestId,
          }),
        ).resolves.toBeUndefined();
        expect(hoisted.runTurnMock).toHaveBeenCalledTimes(1);
      } finally {
        acpManagerTesting.resetAcpSessionManagerForTests();
        const { closeOpenClawAgentDatabasesAsync } =
          await import("../../state/openclaw-agent-db.js");
        await closeOpenClawAgentDatabasesAsync();
        await closeOpenClawStateDatabaseByPathAsync(databasePath);
      }
    });
  });

  it.each([
    ["topic", "telegram:-1003841603622", "498", "-1003841603622:topic:498"],
    ["DM", "telegram:123456789", undefined, "123456789"],
  ] as const)(
    "binds Telegram %s ACP spawns to full conversation ids",
    async (kind, originatingTo, threadId, conversationId) => {
      const result = await runCommand("/acp spawn codex --thread here", baseCfg, {
        Provider: "telegram",
        OriginatingTo: originatingTo,
        ...(threadId ? { MessageThreadId: threadId } : {}),
      });

      expectReplyText(result, "Spawned ACP session agent:main:acp:", "Bound this conversation to");
      if (kind === "topic") {
        expect(result?.reply?.delivery).toEqual({ pin: { enabled: true } });
      } else {
        expect(result?.reply?.channelData).toBeUndefined();
      }
      expectBindingBindCall({
        placement: "current",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId,
        },
      });
    },
  );

  it("rejects spawning without a harness id before initializing or binding", async () => {
    const result = await runCommand("/acp spawn");
    expect(result?.reply?.text).toContain("ACP target harness id is required");
    expect(hoisted.initializeSessionMock).not.toHaveBeenCalled();
    expect(hoisted.sessionBindingBindMock).not.toHaveBeenCalled();
  });

  it("rejects Matrix thread-bound ACP spawn when spawnSessions is disabled", async () => {
    const cfg = {
      ...baseCfg,
      channels: { matrix: { threadBindings: { enabled: true, spawnSessions: false } } },
    } satisfies OpenClawConfig;

    const result = await runCommand("/acp spawn codex", cfg, {
      Provider: "matrix",
      OriginatingTo: "room:!room:example.org",
    });

    expect(result?.reply?.text).toContain("spawnSessions=true");
    expect(hoisted.sessionBindingBindMock).not.toHaveBeenCalled();
  });

  it.each(["off", "all"] as const)(
    "uses the global requester sandbox mode %s for ACP commands",
    async (sandboxMode) => {
      const cfg = {
        ...baseCfg,
        session: { scope: "global" },
        agents: {
          ownership: "explicit",
          entries: { research: { sandbox: { mode: sandboxMode } }, ops: {} },
        },
      } satisfies OpenClawConfig;
      const params = createParams("/acp spawn codex --thread off", cfg);
      params.sessionKey = "global";
      params.agentId = "research";

      const result = await handleAcpCommand(params, true);

      if (sandboxMode === "all") {
        expect(result?.reply?.text).toContain("Sandboxed sessions cannot spawn ACP sessions");
        expect(hoisted.initializeSessionMock).not.toHaveBeenCalled();
      } else {
        expect(result?.reply?.text).toContain("Spawned ACP session");
        expect(hoisted.initializeSessionMock).toHaveBeenCalled();
      }
    },
  );

  it("admits ACP steer with the original channel participant", async () => {
    const captured: unknown[] = [];
    const audit = createChannelAdmissionAudit({ enabled: true });
    const clearSink = configureExecutionIdentityAdmissionSink((work) => {
      captured.push(work);
      return true;
    });
    try {
      mockGatewaySessionResolution(defaultAcpSessionKey);
      hoisted.readAcpSessionEntryMock.mockReturnValue(createAcpSessionEntry());
      const cfg = {
        ...baseCfg,
        logging: { audit: { executionIdentity: true } },
      } satisfies OpenClawConfig;
      const params = createParams(
        `/acp steer --session ${defaultAcpSessionKey} tighten logging`,
        cfg,
      );
      bindTestChannelParticipantAdmissionEvidence({
        audit,
        context: params.ctx,
        channelId: "discord",
        accountId: "default",
        participantId: "user-1",
      });

      await handleAcpCommand(params, true);

      expect(captured).toMatchObject([
        {
          kind: "capture",
          envelope: {
            ingress: { kind: "acp", state: "present" },
            invoker: { state: "present", kind: "person" },
          },
        },
      ]);
    } finally {
      clearSink();
      audit.close();
    }
  });

  it("sends every line of a multiline ACP steer instruction", async () => {
    mockGatewaySessionResolution(defaultAcpSessionKey);
    hoisted.readAcpSessionEntryMock.mockReturnValue(createAcpSessionEntry());

    await runCommand(
      `/acp steer --session ${defaultAcpSessionKey} first line\n  second line\n\nfourth line`,
    );

    expectMockCallFields(hoisted.runTurnMock, {
      mode: "steer",
      text: "first line\n  second line\n\nfourth line",
    });
  });

  it("keeps bounded ACP steer output UTF-16 safe", async () => {
    const prefix = "a".repeat(799);
    mockGatewaySessionResolution(defaultAcpSessionKey);
    hoisted.readAcpSessionEntryMock.mockReturnValue(createAcpSessionEntry());
    hoisted.runTurnMock.mockImplementation(async function* () {
      yield { type: "text_delta", text: `${prefix}😀tail` };
      yield { type: "done" };
    });

    const result = await runCommand(`/acp steer --session ${defaultAcpSessionKey} tighten logging`);

    expectMockCallFields(hoisted.runTurnMock, { mode: "steer", text: "tighten logging" });
    expect(result?.reply?.text).toContain(`\n${prefix}…`);
    expect(result?.reply?.text).not.toContain("😀");
  });

  it.each([
    {
      name: "configured default account",
      cfg: {
        ...baseCfg,
        channels: { discord: { defaultAccount: "work" } },
      } satisfies OpenClawConfig,
      accountId: "work",
    },
    { name: "default account without channel config", cfg: {}, accountId: "default" },
  ])(
    "resolves ACP reset targets through $name when AccountId is omitted",
    async ({ cfg, accountId }) => {
      const conversation = {
        channel: "discord",
        accountId,
        conversationId: defaultThreadId,
        parentConversationId: "parent-1",
      };
      hoisted.sessionBindingResolveByConversationMock.mockImplementation(
        (ref: Partial<SessionBindingRecord["conversation"]>) =>
          ref.channel === "discord" &&
          ref.accountId === accountId &&
          ref.conversationId === defaultThreadId &&
          ref.parentConversationId === "parent-1"
            ? createSessionBinding({
                targetSessionKey: defaultAcpSessionKey,
                conversation,
              })
            : null,
      );

      const result = await resolveEffectiveResetTargetSessionKey({
        cfg,
        channel: "discord",
        conversationId: defaultThreadId,
        parentConversationId: "parent-1",
      });

      expectMockCallFields(hoisted.sessionBindingResolveByConversationMock, conversation);
      expect(result).toBe(defaultAcpSessionKey);
    },
  );

  it("blocks /acp steer when ACP dispatch is disabled by policy", async () => {
    const cfg = {
      ...baseCfg,
      acp: { ...baseCfg.acp, dispatch: { enabled: false } },
    } satisfies OpenClawConfig;
    const result = await runCommand("/acp steer tighten logging", cfg);
    expect(result?.reply?.text).toContain("ACP dispatch is disabled by policy");
    expect(hoisted.runTurnMock).not.toHaveBeenCalled();
  });

  it("closes the bound thread ACP session when an explicit session token is unresolvable", async () => {
    mockGatewaySessionResolution(null);
    mockBoundThreadSession();
    hoisted.sessionBindingUnbindMock.mockResolvedValue([
      createBoundThreadSession() as SessionBindingRecord,
    ]);

    const result = await runThreadAcpCommand("/acp close not-a-session-target");

    expect(hoisted.closeMock).toHaveBeenCalledWith({
      cfg: baseCfg,
      agentId: "codex",
      sessionKey: defaultAcpSessionKey,
      reason: "manual-close",
      allowBackendUnavailable: true,
      clearMeta: true,
    });
    expectMockCallFields(hoisted.sessionBindingUnbindMock, {
      targetSessionKey: defaultAcpSessionKey,
      reason: "manual",
    });
    expect(result?.reply?.text).toContain(`Closed ACP session ${defaultAcpSessionKey}`);
  });

  it("reports an explicit bad ACP session token before requester fallback", async () => {
    mockGatewaySessionResolution(null);
    const params = createParams("/acp close not-a-session-target", baseCfg, {
      SessionKey: "requester-session",
    });

    const result = await handleAcpCommand(params, true);

    expect(result?.reply?.text).toContain("Unable to resolve session target: not-a-session-target");
    expect(hoisted.closeMock).not.toHaveBeenCalled();
    expect(hoisted.readAcpSessionEntryMock).not.toHaveBeenCalled();
  });

  it("lists all stored ACP sessions for the owner", async () => {
    const ownSessionKey = "agent:codex:acp:own";
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createBoundThreadSession(ownSessionKey),
    );
    hoisted.sessionBindingListBySessionMock.mockImplementation((key: string) =>
      key === ownSessionKey ? [createBoundThreadSession(key) as SessionBindingRecord] : [],
    );
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      createAcpSessionEntry({ sessionKey: "agent:codex:acp:own" }),
      createAcpSessionEntry({ sessionKey: "agent:claude:acp:foreign" }),
    ]);

    const result = await runCommand("/acp sessions", baseCfg);

    expect(result?.reply?.text).toContain("ACP sessions:");
    expect(result?.reply?.text).toContain("codex-main");
    expect(result?.reply?.text).toContain(`thread:${defaultThreadId}`);
    expect(result?.reply?.text).toContain("agent:codex:acp:own");
    expect(result?.reply?.text).toContain("agent:claude:acp:foreign");
    expect(hoisted.readAcpSessionEntryMock).not.toHaveBeenCalled();
  });

  it.each([
    { sessionKey: "agent:codex:acp:current", agentId: "codex", isAcp: true },
    { sessionKey: "agent:main:raw-requester", agentId: "main", isAcp: false },
  ])(
    "limits non-owner listings to the current session (ACP=$isAcp)",
    async ({ sessionKey, agentId, isAcp }) => {
      const entry = createAcpSessionEntry({ sessionKey });
      hoisted.readAcpSessionEntryMock.mockReturnValue({
        ...entry,
        acp: isAcp ? entry.acp : undefined,
      });
      const params = createParams("/acp sessions");
      params.command.senderIsOwner = false;
      params.sessionKey = sessionKey;
      if (isAcp) {
        params.agentId = agentId;
      }

      const result = await handleAcpCommand(params, true);

      expect(result?.reply?.text).toContain(isAcp ? sessionKey : "(none)");
      expect(hoisted.readAcpSessionEntryMock).toHaveBeenCalledWith({
        cfg: baseCfg,
        agentId,
        sessionKey,
      });
      expect(hoisted.listAcpSessionEntriesMock).not.toHaveBeenCalled();
    },
  );

  it("warns when no session key resolves for /acp sessions", async () => {
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([createAcpSessionEntry()]);
    const params = createParams("/acp sessions");
    params.command.senderIsOwner = false;
    params.sessionKey = "";

    const result = await handleAcpCommand(params, true);

    expect(result?.reply?.text).toContain("Missing session key");
  });

  it("rejects explicit target tokens for /acp sessions", async () => {
    const params = createParams("/acp sessions agent:claude:acp:foreign");
    params.command.senderIsOwner = false;

    const result = await handleAcpCommand(params, true);

    expect(result?.reply?.text).toBe("Usage: /acp sessions");
    expect(hoisted.readAcpSessionEntryMock).not.toHaveBeenCalled();
    expect(hoisted.listAcpSessionEntriesMock).not.toHaveBeenCalled();
  });

  it("renders invalid timestamps and sanitizes leaked task and runtime details in ACP status", async () => {
    const leakedDetails = [
      "OpenClaw runtime context (internal):",
      "This context is runtime-generated, not user-authored. Keep internal details private.",
      "",
      "[Internal task completion event]",
      "source: subagent",
    ].join("\n");
    mockBoundThreadSession({
      acp: {
        lastActivityAt: 8_700_000_000_000_000,
        identity: {
          state: "resolved",
          source: "status",
          acpxSessionId: "acpx-sid-1",
          agentSessionId: "codex-sid-1",
          lastUpdatedAt: Date.now(),
        },
        lastError: leakedDetails,
      },
    });
    hoisted.getStatusMock.mockResolvedValue({
      summary: leakedDetails,
      details: { payload: leakedDetails },
    });

    const result = await runThreadAcpCommand("/acp status", baseCfg);

    expect(result?.reply?.text).toContain("ACP status:");
    expect(result?.reply?.text).toContain(`session: ${defaultAcpSessionKey}`);
    expect(result?.reply?.text).toContain("agent session id: codex-sid-1");
    expect(result?.reply?.text).toContain("acpx session id: acpx-sid-1");
    expect(result?.reply?.text).toContain("capabilities:");
    expect(result?.reply?.text).toContain("lastActivityAt: n/a");
    expect(result?.reply?.text).not.toContain("taskUpdatedAt:");
    expect(result?.reply?.text).not.toContain("OpenClaw runtime context (internal):");
    expect(result?.reply?.text).not.toContain("Internal task completion event");
  });

  it.each(["operator.write", "operator.admin"])("gates ACP mutation with %s", async (scope) => {
    mockBoundThreadSession();

    const params = buildCommandTestParams("/acp set-mode plan", baseCfg, {
      Provider: INTERNAL_MESSAGE_CHANNEL,
      Surface: INTERNAL_MESSAGE_CHANNEL,
      OriginatingChannel: INTERNAL_MESSAGE_CHANNEL,
      OriginatingTo: "webchat:conversation-1",
      GatewayClientScopes: [scope],
    });
    params.command.channel = INTERNAL_MESSAGE_CHANNEL;
    params.command.senderId = "user-1";
    const result = await handleAcpCommand(params, true);

    if (scope === "operator.write") {
      expect(result?.shouldContinue).toBe(false);
      expect(result?.reply?.text).toContain("requires operator.admin");
    } else {
      expectMockCallFields(hoisted.setModeMock, {
        cfg: baseCfg,
        runtimeMode: "plan",
      });
      expect(result?.reply?.text).toContain("Updated ACP runtime mode");
    }
  });

  it.each([
    {
      action: "set model",
      value: "gpt-5.4",
      effectiveOptions: { model: "gpt-5.4" },
      managerMock: hoisted.setConfigOptionMock,
      managerInput: { key: "model", value: "gpt-5.4" },
      expectedText: `✅ Updated ACP config option for ${defaultAcpSessionKey}: model=gpt-5.4. Effective options: model=gpt-5.4`,
    },
    {
      action: "set cwd",
      value: "/tmp/worktree",
      effectiveOptions: { cwd: "/tmp/worktree" },
      managerMock: hoisted.updateSessionRuntimeOptionsMock,
      managerInput: { patch: { cwd: "/tmp/worktree" } },
      expectedText: `✅ Updated ACP cwd for ${defaultAcpSessionKey}: /tmp/worktree. Effective options: cwd=/tmp/worktree`,
    },
    {
      action: "cwd",
      value: "/tmp/worktree",
      effectiveOptions: { cwd: "/tmp/worktree" },
      managerMock: hoisted.updateSessionRuntimeOptionsMock,
      managerInput: { patch: { cwd: "/tmp/worktree" } },
      expectedText: `✅ Updated ACP cwd for ${defaultAcpSessionKey}: /tmp/worktree. Effective options: cwd=/tmp/worktree`,
    },
    {
      action: "timeout",
      value: "120",
      effectiveOptions: { timeoutSeconds: 120 },
      managerMock: hoisted.setConfigOptionMock,
      managerInput: { key: "timeout", value: "120" },
      expectedText: `✅ Updated ACP timeout for ${defaultAcpSessionKey}: 120s. Effective options: timeoutSeconds=120`,
    },
  ])("routes ACP $action to its runtime-option owner", async (testCase) => {
    mockBoundThreadSession();
    testCase.managerMock.mockResolvedValueOnce(testCase.effectiveOptions);

    const result = await runThreadAcpCommand(`/acp ${testCase.action} ${testCase.value}`, baseCfg);

    expect(result?.reply?.text).toBe(testCase.expectedText);
    expectMockCallFields(testCase.managerMock, {
      cfg: baseCfg,
      sessionKey: defaultAcpSessionKey,
      ...testCase.managerInput,
    });
  });

  it("preserves the model failure boundary", async () => {
    mockBoundThreadSession();
    hoisted.setConfigOptionMock.mockRejectedValueOnce("backend failure");

    const result = await runThreadAcpCommand("/acp model openai/gpt-5.5", baseCfg);

    expect(result?.reply?.text).toBe(
      "ACP error (ACP_TURN_FAILED): Could not update ACP model.\nnext: Retry, or use `/acp cancel` and send the message again.",
    );
  });

  it.each([
    [
      { runtime: { installCommand: "pnpm openclaw plugins install acpx" } },
      "pnpm openclaw plugins install acpx",
    ],
    [
      { backend: "acpx" },
      `openclaw plugins install ${path.join(process.cwd(), "extensions", "acpx")}`,
    ],
    [
      { backend: "custom-backend" },
      'Install and enable the plugin that provides ACP backend "custom-backend".',
    ],
  ] as const)("shows install guidance through /acp install (%j)", async (acp, hint) => {
    const result = await runCommand("/acp install", {
      ...baseCfg,
      acp: { ...baseCfg.acp, ...acp },
    });
    expectReplyText(result, "ACP install:", `run: ${hint}\nthen:`);
  });

  it("offers the package install when no workspace extension exists", async () => {
    const cwd = vi
      .spyOn(process, "cwd")
      .mockReturnValue(path.join(process.cwd(), "missing-workspace"));
    try {
      expectReplyText(
        await runCommand("/acp install"),
        "ACP install:",
        "run: openclaw plugins install acpx\nthen:",
      );
    } finally {
      cwd.mockRestore();
    }
  });

  it("explains when acpx is blocked by plugins.allow", async () => {
    hoisted.getAcpRuntimeBackendMock.mockReturnValue(null);
    hoisted.requireAcpRuntimeBackendMock.mockImplementation(() => {
      throw new AcpRuntimeError(
        "ACP_BACKEND_MISSING",
        "ACP runtime backend is not configured. Install and enable the acpx runtime plugin.",
      );
    });

    const result = await runCommand("/acp doctor", {
      ...baseCfg,
      plugins: { allow: ["discord"] },
    });

    expectReplyText(result, "pluginActivation: blocked", "acpx", 'add "acpx" to plugins.allow');
  });
});
