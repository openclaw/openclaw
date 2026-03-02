import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpRuntimeError } from "../../acp/runtime/errors.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";

const hoisted = vi.hoisted(() => {
  const callGatewayMock = vi.fn();
  const requireAcpRuntimeBackendMock = vi.fn();
  const getAcpRuntimeBackendMock = vi.fn();
  const listAcpSessionEntriesMock = vi.fn();
  const readAcpSessionEntryMock = vi.fn();
  const upsertAcpSessionMetaMock = vi.fn();
  const resolveSessionStorePathForAcpMock = vi.fn();
  const loadSessionStoreMock = vi.fn();
  const sessionBindingCapabilitiesMock = vi.fn();
  const sessionBindingBindMock = vi.fn();
  const sessionBindingListBySessionMock = vi.fn();
  const sessionBindingResolveByConversationMock = vi.fn();
  const sessionBindingUnbindMock = vi.fn();
  const ensureSessionMock = vi.fn();
  const runTurnMock = vi.fn();
  const cancelMock = vi.fn();
  const closeMock = vi.fn();
  const getCapabilitiesMock = vi.fn();
  const getStatusMock = vi.fn();
  const setModeMock = vi.fn();
  const setConfigOptionMock = vi.fn();
  const doctorMock = vi.fn();
  return {
    callGatewayMock,
    requireAcpRuntimeBackendMock,
    getAcpRuntimeBackendMock,
    listAcpSessionEntriesMock,
    readAcpSessionEntryMock,
    upsertAcpSessionMetaMock,
    resolveSessionStorePathForAcpMock,
    loadSessionStoreMock,
    sessionBindingCapabilitiesMock,
    sessionBindingBindMock,
    sessionBindingListBySessionMock,
    sessionBindingResolveByConversationMock,
    sessionBindingUnbindMock,
    ensureSessionMock,
    runTurnMock,
    cancelMock,
    closeMock,
    getCapabilitiesMock,
    getStatusMock,
    setModeMock,
    setConfigOptionMock,
    doctorMock,
  };
});

function createAcpCommandSessionBindingService() {
  const forward =
    <A extends unknown[], T>(fn: (...args: A) => T) =>
    (...args: A) =>
      fn(...args);
  return {
    bind: (input: unknown) => hoisted.sessionBindingBindMock(input),
    getCapabilities: forward((params: unknown) => hoisted.sessionBindingCapabilitiesMock(params)),
    listBySession: (targetSessionKey: string) =>
      hoisted.sessionBindingListBySessionMock(targetSessionKey),
    resolveByConversation: (ref: unknown) => hoisted.sessionBindingResolveByConversationMock(ref),
    touch: vi.fn(),
    unbind: (input: unknown) => hoisted.sessionBindingUnbindMock(input),
  };
}

vi.mock("../../gateway/call.js", () => ({
  callGateway: (args: unknown) => hoisted.callGatewayMock(args),
}));

vi.mock("../../acp/runtime/registry.js", () => ({
  requireAcpRuntimeBackend: (id?: string) => hoisted.requireAcpRuntimeBackendMock(id),
  getAcpRuntimeBackend: (id?: string) => hoisted.getAcpRuntimeBackendMock(id),
}));

vi.mock("../../acp/runtime/session-meta.js", () => ({
  listAcpSessionEntries: (args: unknown) => hoisted.listAcpSessionEntriesMock(args),
  readAcpSessionEntry: (args: unknown) => hoisted.readAcpSessionEntryMock(args),
  upsertAcpSessionMeta: (args: unknown) => hoisted.upsertAcpSessionMetaMock(args),
  resolveSessionStorePathForAcp: (args: unknown) => hoisted.resolveSessionStorePathForAcpMock(args),
}));

vi.mock("../../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions.js")>();
  return {
    ...actual,
    loadSessionStore: (...args: unknown[]) => hoisted.loadSessionStoreMock(...args),
  };
});

vi.mock("../../infra/outbound/session-binding-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/outbound/session-binding-service.js")>();
  const patched = { ...actual } as typeof actual & {
    getSessionBindingService: () => ReturnType<typeof createAcpCommandSessionBindingService>;
  };
  patched.getSessionBindingService = () => createAcpCommandSessionBindingService();
  return patched;
});

// Prevent transitive import chain from reaching discord/monitor which needs https-proxy-agent.
vi.mock("../../discord/monitor/gateway-plugin.js", () => ({
  createDiscordGatewayPlugin: () => ({}),
}));

const { handleAcpCommand } = await import("./commands-acp.js");
const { buildCommandTestParams } = await import("./commands-spawn.test-harness.js");
const { __testing: acpManagerTesting } = await import("../../acp/control-plane/manager.js");

type FakeBinding = {
  bindingId: string;
  targetSessionKey: string;
  targetKind: "subagent" | "session";
  conversation: {
    channel: "discord";
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
  };
  status: "active";
  boundAt: number;
  metadata?: {
    agentId?: string;
    label?: string;
    boundBy?: string;
    webhookId?: string;
  };
};

function createSessionBinding(overrides?: Partial<FakeBinding>): FakeBinding {
  return {
    bindingId: "default:thread-created",
    targetSessionKey: "agent:codex:acp:s1",
    targetKind: "session",
    conversation: {
      channel: "discord",
      accountId: "default",
      conversationId: "thread-created",
      parentConversationId: "parent-1",
    },
    status: "active",
    boundAt: Date.now(),
    metadata: {
      agentId: "codex",
      boundBy: "user-1",
    },
    ...overrides,
  };
}

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
  acp: {
    enabled: true,
    dispatch: { enabled: true },
    backend: "acpx",
  },
  channels: {
    discord: {
      threadBindings: {
        enabled: true,
        spawnAcpSessions: true,
      },
    },
  },
} satisfies OpenClawConfig;

function createDiscordParams(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  const params = buildCommandTestParams(commandBody, cfg, {
    Provider: "discord",
    Surface: "discord",
    OriginatingChannel: "discord",
    OriginatingTo: "channel:parent-1",
    AccountId: "default",
  });
  params.command.senderId = "user-1";
  return params;
}

const defaultAcpSessionKey = "agent:codex:acp:s1";
const defaultThreadId = "thread-1";

type AcpSessionIdentity = {
  state: "resolved";
  source: "status";
  acpxSessionId: string;
  agentSessionId: string;
  lastUpdatedAt: number;
};

function createThreadConversation(conversationId: string = defaultThreadId) {
  return {
    channel: "discord" as const,
    accountId: "default",
    conversationId,
    parentConversationId: "parent-1",
  };
}

function createBoundThreadSession(sessionKey: string = defaultAcpSessionKey) {
  return createSessionBinding({
    targetSessionKey: sessionKey,
    conversation: createThreadConversation(),
  });
}

function createAcpSessionEntry(options?: {
  sessionKey?: string;
  state?: "idle" | "running";
  identity?: AcpSessionIdentity;
}) {
  const sessionKey = options?.sessionKey ?? defaultAcpSessionKey;
  return {
    sessionKey,
    storeSessionKey: sessionKey,
    acp: {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "runtime-1",
      ...(options?.identity ? { identity: options.identity } : {}),
      mode: "persistent",
      state: options?.state ?? "idle",
      lastActivityAt: Date.now(),
    },
  };
}

function createSessionBindingCapabilities() {
  return {
    adapterAvailable: true,
    bindSupported: true,
    unbindSupported: true,
    placements: ["current", "child"] as const,
  };
}

type AcpBindInput = {
  targetSessionKey: string;
  conversation: { accountId: string; conversationId: string };
  placement: "current" | "child";
  metadata?: Record<string, unknown>;
};

function createAcpThreadBinding(input: AcpBindInput): FakeBinding {
  const nextConversationId =
    input.placement === "child" ? "thread-created" : input.conversation.conversationId;
  const boundBy = typeof input.metadata?.boundBy === "string" ? input.metadata.boundBy : "user-1";
  return createSessionBinding({
    targetSessionKey: input.targetSessionKey,
    conversation: {
      channel: "discord",
      accountId: input.conversation.accountId,
      conversationId: nextConversationId,
      parentConversationId: "parent-1",
    },
    metadata: { boundBy, webhookId: "wh-1" },
  });
}

function expectBoundIntroTextToExclude(match: string): void {
  const calls = hoisted.sessionBindingBindMock.mock.calls as Array<
    [{ metadata?: { introText?: unknown } }]
  >;
  const introText = calls
    .map((call) => call[0]?.metadata?.introText)
    .find((value): value is string => typeof value === "string");
  expect((introText ?? "").includes(match)).toBe(false);
}

function mockBoundThreadSession(options?: {
  sessionKey?: string;
  state?: "idle" | "running";
  identity?: AcpSessionIdentity;
}) {
  const sessionKey = options?.sessionKey ?? defaultAcpSessionKey;
  hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
    createBoundThreadSession(sessionKey),
  );
  hoisted.readAcpSessionEntryMock.mockReturnValue(
    createAcpSessionEntry({
      sessionKey,
      state: options?.state,
      identity: options?.identity,
    }),
  );
}

function createThreadParams(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  const params = createDiscordParams(commandBody, cfg);
  params.ctx.MessageThreadId = defaultThreadId;
  return params;
}

async function runDiscordAcpCommand(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  return handleAcpCommand(createDiscordParams(commandBody, cfg), true);
}

async function runThreadAcpCommand(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  return handleAcpCommand(createThreadParams(commandBody, cfg), true);
}

describe("/acp command", () => {
  beforeEach(() => {
    acpManagerTesting.resetAcpSessionManagerForTests();
    hoisted.listAcpSessionEntriesMock.mockReset().mockResolvedValue([]);
    hoisted.callGatewayMock.mockReset().mockResolvedValue({ ok: true });
    hoisted.readAcpSessionEntryMock.mockReset().mockReturnValue(null);
    hoisted.upsertAcpSessionMetaMock.mockReset().mockResolvedValue({
      sessionId: "session-1",
      updatedAt: Date.now(),
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "run-1",
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
      },
    });
    hoisted.resolveSessionStorePathForAcpMock.mockReset().mockReturnValue({
      cfg: baseCfg,
      storePath: "/tmp/sessions-acp.json",
    });
    hoisted.loadSessionStoreMock.mockReset().mockReturnValue({});
    hoisted.sessionBindingCapabilitiesMock
      .mockReset()
      .mockReturnValue(createSessionBindingCapabilities());
    hoisted.sessionBindingBindMock
      .mockReset()
      .mockImplementation(async (input: AcpBindInput) => createAcpThreadBinding(input));
    hoisted.sessionBindingListBySessionMock.mockReset().mockReturnValue([]);
    hoisted.sessionBindingResolveByConversationMock.mockReset().mockReturnValue(null);
    hoisted.sessionBindingUnbindMock.mockReset().mockResolvedValue([]);

    hoisted.ensureSessionMock
      .mockReset()
      .mockImplementation(async (input: { sessionKey: string }) => ({
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: `${input.sessionKey}:runtime`,
      }));
    hoisted.runTurnMock.mockReset().mockImplementation(async function* () {
      yield { type: "done" };
    });
    hoisted.cancelMock.mockReset().mockResolvedValue(undefined);
    hoisted.closeMock.mockReset().mockResolvedValue(undefined);
    hoisted.getCapabilitiesMock.mockReset().mockResolvedValue({
      controls: ["session/set_mode", "session/set_config_option", "session/status"],
    });
    hoisted.getStatusMock.mockReset().mockResolvedValue({
      summary: "status=alive sessionId=sid-1 pid=1234",
      details: { status: "alive", sessionId: "sid-1", pid: 1234 },
    });
    hoisted.setModeMock.mockReset().mockResolvedValue(undefined);
    hoisted.setConfigOptionMock.mockReset().mockResolvedValue(undefined);
    hoisted.doctorMock.mockReset().mockResolvedValue({
      ok: true,
      message: "acpx command available",
    });

    const runtimeBackend = {
      id: "acpx",
      runtime: {
        ensureSession: hoisted.ensureSessionMock,
        runTurn: hoisted.runTurnMock,
        getCapabilities: hoisted.getCapabilitiesMock,
        getStatus: hoisted.getStatusMock,
        setMode: hoisted.setModeMock,
        setConfigOption: hoisted.setConfigOptionMock,
        doctor: hoisted.doctorMock,
        cancel: hoisted.cancelMock,
        close: hoisted.closeMock,
      },
    };
    hoisted.requireAcpRuntimeBackendMock.mockReset().mockReturnValue(runtimeBackend);
    hoisted.getAcpRuntimeBackendMock.mockReset().mockReturnValue(runtimeBackend);
  });

  it("returns null when the message is not /acp", async () => {
    const result = await runDiscordAcpCommand("/status");
    expect(result).toBeNull();
  });

  it("shows help by default", async () => {
    const result = await runDiscordAcpCommand("/acp");
    expect(result?.reply?.text).toContain("ACP commands:");
    expect(result?.reply?.text).toContain("/acp spawn");
  });

  it("spawns an ACP session and binds a Discord thread", async () => {
    hoisted.ensureSessionMock.mockResolvedValueOnce({
      sessionKey: "agent:codex:acp:s1",
      backend: "acpx",
      runtimeSessionName: "agent:codex:acp:s1:runtime",
      agentSessionId: "codex-inner-1",
      backendSessionId: "acpx-1",
    });

    const result = await runDiscordAcpCommand("/acp spawn codex --cwd /home/bob/clawd");

    expect(result?.reply?.text).toContain("Spawned ACP session agent:codex:acp:");
    expect(result?.reply?.text).toContain("Created thread thread-created and bound it");
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledWith("acpx");
    expect(hoisted.ensureSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "codex",
        mode: "persistent",
        cwd: "/home/bob/clawd",
      }),
    );
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetKind: "session",
        placement: "child",
        metadata: expect.objectContaining({
          introText: expect.stringContaining("cwd: /home/bob/clawd"),
        }),
      }),
    );
    expectBoundIntroTextToExclude("session ids: pending (available after the first reply)");
    expect(hoisted.callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.patch",
      }),
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalled();
    const upsertArgs = hoisted.upsertAcpSessionMetaMock.mock.calls[0]?.[0] as
      | {
          sessionKey: string;
          mutate: (
            current: unknown,
            entry: { sessionId: string; updatedAt: number } | undefined,
          ) => {
            backend?: string;
            runtimeSessionName?: string;
          };
        }
      | undefined;
    expect(upsertArgs?.sessionKey).toMatch(/^agent:codex:acp:/);
    const seededWithoutEntry = upsertArgs?.mutate(undefined, undefined);
    expect(seededWithoutEntry?.backend).toBe("acpx");
    expect(seededWithoutEntry?.runtimeSessionName).toContain(":runtime");
  });

  it("requires explicit ACP target when acp.defaultAgent is not configured", async () => {
    const result = await runDiscordAcpCommand("/acp spawn");

    expect(result?.reply?.text).toContain("ACP target agent is required");
    expect(hoisted.ensureSessionMock).not.toHaveBeenCalled();
  });

  it("rejects thread-bound ACP spawn when spawnAcpSessions is disabled", async () => {
    const cfg = {
      ...baseCfg,
      channels: {
        discord: {
          threadBindings: {
            enabled: true,
            spawnAcpSessions: false,
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = await runDiscordAcpCommand("/acp spawn codex", cfg);

    expect(result?.reply?.text).toContain("spawnAcpSessions=true");
    expect(hoisted.closeMock).toHaveBeenCalledTimes(1);
    expect(hoisted.callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.delete",
        params: expect.objectContaining({
          key: expect.stringMatching(/^agent:codex:acp:/),
          deleteTranscript: false,
          emitLifecycleHooks: false,
        }),
      }),
    );
    expect(hoisted.callGatewayMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "sessions.patch" }),
    );
  });

  it("cancels the ACP session bound to the current thread", async () => {
    mockBoundThreadSession({ state: "running" });
    const result = await runThreadAcpCommand("/acp cancel", baseCfg);
    expect(result?.reply?.text).toContain(
      `Cancel requested for ACP session ${defaultAcpSessionKey}`,
    );
    expect(hoisted.cancelMock).toHaveBeenCalledWith({
      handle: expect.objectContaining({
        sessionKey: defaultAcpSessionKey,
        backend: "acpx",
      }),
      reason: "manual-cancel",
    });
  });

  it("sends steer instructions via ACP runtime", async () => {
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "sessions.resolve") {
        return { key: defaultAcpSessionKey };
      }
      return { ok: true };
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue(createAcpSessionEntry());
    hoisted.runTurnMock.mockImplementation(async function* () {
      yield { type: "text_delta", text: "Applied steering." };
      yield { type: "done" };
    });

    const result = await runDiscordAcpCommand(
      `/acp steer --session ${defaultAcpSessionKey} tighten logging`,
    );

    expect(hoisted.runTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "steer",
        text: "tighten logging",
      }),
    );
    expect(result?.reply?.text).toContain("Applied steering.");
  });

  it("blocks /acp steer when ACP dispatch is disabled by policy", async () => {
    const cfg = {
      ...baseCfg,
      acp: {
        ...baseCfg.acp,
        dispatch: { enabled: false },
      },
    } satisfies OpenClawConfig;
    const result = await runDiscordAcpCommand("/acp steer tighten logging", cfg);
    expect(result?.reply?.text).toContain("ACP dispatch is disabled by policy");
    expect(hoisted.runTurnMock).not.toHaveBeenCalled();
  });

  it("closes an ACP session, unbinds thread targets, and clears metadata", async () => {
    mockBoundThreadSession();
    hoisted.sessionBindingUnbindMock.mockResolvedValue([
      createBoundThreadSession() as SessionBindingRecord,
    ]);

    const result = await runThreadAcpCommand("/acp close", baseCfg);

    expect(hoisted.closeMock).toHaveBeenCalledTimes(1);
    expect(hoisted.sessionBindingUnbindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSessionKey: defaultAcpSessionKey,
        reason: "manual",
      }),
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalled();
    expect(result?.reply?.text).toContain("Removed 1 binding");
  });

  it("lists ACP sessions from the session store", async () => {
    hoisted.sessionBindingListBySessionMock.mockImplementation((key: string) =>
      key === defaultAcpSessionKey ? [createBoundThreadSession(key) as SessionBindingRecord] : [],
    );
    hoisted.loadSessionStoreMock.mockReturnValue({
      [defaultAcpSessionKey]: {
        sessionId: "sess-1",
        updatedAt: Date.now(),
        label: "codex-main",
        acp: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "runtime-1",
          mode: "persistent",
          state: "idle",
          lastActivityAt: Date.now(),
        },
      },
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: Date.now(),
      },
    });

    const result = await runDiscordAcpCommand("/acp sessions", baseCfg);

    expect(result?.reply?.text).toContain("ACP sessions:");
    expect(result?.reply?.text).toContain("codex-main");
    expect(result?.reply?.text).toContain(`thread:${defaultThreadId}`);
  });

  it("shows ACP status for the thread-bound ACP session", async () => {
    mockBoundThreadSession({
      identity: {
        state: "resolved",
        source: "status",
        acpxSessionId: "acpx-sid-1",
        agentSessionId: "codex-sid-1",
        lastUpdatedAt: Date.now(),
      },
    });
    const result = await runThreadAcpCommand("/acp status", baseCfg);

    expect(result?.reply?.text).toContain("ACP status:");
    expect(result?.reply?.text).toContain(`session: ${defaultAcpSessionKey}`);
    expect(result?.reply?.text).toContain("agent session id: codex-sid-1");
    expect(result?.reply?.text).toContain("acpx session id: acpx-sid-1");
    expect(result?.reply?.text).toContain("capabilities:");
    expect(hoisted.getStatusMock).toHaveBeenCalledTimes(1);
  });

  it("updates ACP runtime mode via /acp set-mode", async () => {
    mockBoundThreadSession();
    const result = await runThreadAcpCommand("/acp set-mode plan", baseCfg);

    expect(hoisted.setModeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "plan",
      }),
    );
    expect(result?.reply?.text).toContain("Updated ACP runtime mode");
  });

  it("updates ACP config options and keeps cwd local when using /acp set", async () => {
    mockBoundThreadSession();

    const setModel = await runThreadAcpCommand("/acp set model gpt-5.3-codex", baseCfg);
    expect(hoisted.setConfigOptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "model",
        value: "gpt-5.3-codex",
      }),
    );
    expect(setModel?.reply?.text).toContain("Updated ACP config option");

    hoisted.setConfigOptionMock.mockClear();
    const setCwd = await runThreadAcpCommand("/acp set cwd /tmp/worktree", baseCfg);
    expect(hoisted.setConfigOptionMock).not.toHaveBeenCalled();
    expect(setCwd?.reply?.text).toContain("Updated ACP cwd");
  });

  it("rejects non-absolute cwd values via ACP runtime option validation", async () => {
    mockBoundThreadSession();

    const result = await runThreadAcpCommand("/acp cwd relative/path", baseCfg);

    expect(result?.reply?.text).toContain("ACP error (ACP_INVALID_RUNTIME_OPTION)");
    expect(result?.reply?.text).toContain("absolute path");
  });

  it("rejects invalid timeout values before backend config writes", async () => {
    mockBoundThreadSession();

    const result = await runThreadAcpCommand("/acp timeout 10s", baseCfg);

    expect(result?.reply?.text).toContain("ACP error (ACP_INVALID_RUNTIME_OPTION)");
    expect(hoisted.setConfigOptionMock).not.toHaveBeenCalled();
  });

  it("returns actionable doctor output when backend is missing", async () => {
    hoisted.getAcpRuntimeBackendMock.mockReturnValue(null);
    hoisted.requireAcpRuntimeBackendMock.mockImplementation(() => {
      throw new AcpRuntimeError(
        "ACP_BACKEND_MISSING",
        "ACP runtime backend is not configured. Install and enable the acpx runtime plugin.",
      );
    });

    const result = await runDiscordAcpCommand("/acp doctor", baseCfg);

    expect(result?.reply?.text).toContain("ACP doctor:");
    expect(result?.reply?.text).toContain("healthy: no");
    expect(result?.reply?.text).toContain("next:");
  });

  it("shows deterministic install instructions via /acp install", async () => {
    const result = await runDiscordAcpCommand("/acp install", baseCfg);

    expect(result?.reply?.text).toContain("ACP install:");
    expect(result?.reply?.text).toContain("run:");
    expect(result?.reply?.text).toContain("then: /acp doctor");
  });
});
