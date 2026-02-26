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
  return {
    ...actual,
    getSessionBindingService: () => ({
      bind: (input: unknown) => hoisted.sessionBindingBindMock(input),
      getCapabilities: (params: unknown) => hoisted.sessionBindingCapabilitiesMock(params),
      listBySession: (targetSessionKey: string) =>
        hoisted.sessionBindingListBySessionMock(targetSessionKey),
      resolveByConversation: (ref: unknown) => hoisted.sessionBindingResolveByConversationMock(ref),
      touch: vi.fn(),
      unbind: (input: unknown) => hoisted.sessionBindingUnbindMock(input),
    }),
  };
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
    hoisted.sessionBindingCapabilitiesMock.mockReset().mockReturnValue({
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current", "child"],
    });
    hoisted.sessionBindingBindMock
      .mockReset()
      .mockImplementation(
        async (input: {
          targetSessionKey: string;
          conversation: { accountId: string; conversationId: string };
          placement: "current" | "child";
          metadata?: Record<string, unknown>;
        }) =>
          createSessionBinding({
            targetSessionKey: input.targetSessionKey,
            conversation: {
              channel: "discord",
              accountId: input.conversation.accountId,
              conversationId:
                input.placement === "child" ? "thread-created" : input.conversation.conversationId,
              parentConversationId: "parent-1",
            },
            metadata: {
              boundBy:
                typeof input.metadata?.boundBy === "string" ? input.metadata.boundBy : "user-1",
              webhookId: "wh-1",
            },
          }),
      );
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
    const params = createDiscordParams("/status");
    const result = await handleAcpCommand(params, true);
    expect(result).toBeNull();
  });

  it("shows help by default", async () => {
    const params = createDiscordParams("/acp");
    const result = await handleAcpCommand(params, true);
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

    const params = createDiscordParams("/acp spawn codex --cwd /home/bob/clawd");
    const result = await handleAcpCommand(params, true);

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
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          introText: expect.not.stringContaining(
            "session ids: pending (available after the first reply)",
          ),
        }),
      }),
    );
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
    const params = createDiscordParams("/acp spawn");
    const result = await handleAcpCommand(params, true);

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

    const params = createDiscordParams("/acp spawn codex", cfg);
    const result = await handleAcpCommand(params, true);

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
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createSessionBinding({
        targetSessionKey: "agent:codex:acp:s1",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "thread-1",
          parentConversationId: "parent-1",
        },
      }),
    );
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:s1",
      storeSessionKey: "agent:codex:acp:s1",
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "runtime-1",
        mode: "persistent",
        state: "running",
        lastActivityAt: Date.now(),
      },
    });

    const params = createDiscordParams("/acp cancel", baseCfg);
    params.ctx.MessageThreadId = "thread-1";

    const result = await handleAcpCommand(params, true);
    expect(result?.reply?.text).toContain("Cancel requested for ACP session agent:codex:acp:s1");
    expect(hoisted.cancelMock).toHaveBeenCalledWith({
      handle: expect.objectContaining({
        sessionKey: "agent:codex:acp:s1",
        backend: "acpx",
      }),
      reason: "manual-cancel",
    });
  });

  it("sends steer instructions via ACP runtime", async () => {
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "sessions.resolve") {
        return { key: "agent:codex:acp:s1" };
      }
      return { ok: true };
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:s1",
      storeSessionKey: "agent:codex:acp:s1",
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "runtime-1",
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
      },
    });
    hoisted.runTurnMock.mockImplementation(async function* () {
      yield { type: "text_delta", text: "Applied steering." };
      yield { type: "done" };
    });

    const params = createDiscordParams("/acp steer --session agent:codex:acp:s1 tighten logging");
    const result = await handleAcpCommand(params, true);

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
    const params = createDiscordParams("/acp steer tighten logging", cfg);
    const result = await handleAcpCommand(params, true);
    expect(result?.reply?.text).toContain("ACP dispatch is disabled by policy");
    expect(hoisted.runTurnMock).not.toHaveBeenCalled();
  });

  it("closes an ACP session, unbinds thread targets, and clears metadata", async () => {
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createSessionBinding({
        targetSessionKey: "agent:codex:acp:s1",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "thread-1",
          parentConversationId: "parent-1",
        },
      }),
    );
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:s1",
      storeSessionKey: "agent:codex:acp:s1",
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "runtime-1",
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
      },
    });
    hoisted.sessionBindingUnbindMock.mockResolvedValue([
      createSessionBinding({
        targetSessionKey: "agent:codex:acp:s1",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "thread-1",
          parentConversationId: "parent-1",
        },
      }) as SessionBindingRecord,
    ]);

    const params = createDiscordParams("/acp close", baseCfg);
    params.ctx.MessageThreadId = "thread-1";

    const result = await handleAcpCommand(params, true);

    expect(hoisted.closeMock).toHaveBeenCalledTimes(1);
    expect(hoisted.sessionBindingUnbindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSessionKey: "agent:codex:acp:s1",
        reason: "manual",
      }),
    );
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalled();
    expect(result?.reply?.text).toContain("Removed 1 binding");
  });

  it("lists ACP sessions from the session store", async () => {
    hoisted.sessionBindingListBySessionMock.mockImplementation((key: string) =>
      key === "agent:codex:acp:s1"
        ? [
            createSessionBinding({
              targetSessionKey: key,
              conversation: {
                channel: "discord",
                accountId: "default",
                conversationId: "thread-1",
                parentConversationId: "parent-1",
              },
            }) as SessionBindingRecord,
          ]
        : [],
    );
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:codex:acp:s1": {
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

    const params = createDiscordParams("/acp sessions", baseCfg);
    const result = await handleAcpCommand(params, true);

    expect(result?.reply?.text).toContain("ACP sessions:");
    expect(result?.reply?.text).toContain("codex-main");
    expect(result?.reply?.text).toContain("thread:thread-1");
  });

  it("shows ACP status for the thread-bound ACP session", async () => {
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createSessionBinding({
        targetSessionKey: "agent:codex:acp:s1",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "thread-1",
          parentConversationId: "parent-1",
        },
      }),
    );
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:s1",
      storeSessionKey: "agent:codex:acp:s1",
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "runtime-1",
        identity: {
          state: "resolved",
          source: "status",
          acpxSessionId: "acpx-sid-1",
          agentSessionId: "codex-sid-1",
          lastUpdatedAt: Date.now(),
        },
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
      },
    });
    const params = createDiscordParams("/acp status", baseCfg);
    params.ctx.MessageThreadId = "thread-1";

    const result = await handleAcpCommand(params, true);

    expect(result?.reply?.text).toContain("ACP status:");
    expect(result?.reply?.text).toContain("session: agent:codex:acp:s1");
    expect(result?.reply?.text).toContain("agent session id: codex-sid-1");
    expect(result?.reply?.text).toContain("acpx session id: acpx-sid-1");
    expect(result?.reply?.text).toContain("capabilities:");
    expect(hoisted.getStatusMock).toHaveBeenCalledTimes(1);
  });

  it("updates ACP runtime mode via /acp set-mode", async () => {
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createSessionBinding({
        targetSessionKey: "agent:codex:acp:s1",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "thread-1",
          parentConversationId: "parent-1",
        },
      }),
    );
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:s1",
      storeSessionKey: "agent:codex:acp:s1",
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "runtime-1",
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
      },
    });
    const params = createDiscordParams("/acp set-mode plan", baseCfg);
    params.ctx.MessageThreadId = "thread-1";

    const result = await handleAcpCommand(params, true);

    expect(hoisted.setModeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "plan",
      }),
    );
    expect(result?.reply?.text).toContain("Updated ACP runtime mode");
  });

  it("updates ACP config options and keeps cwd local when using /acp set", async () => {
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createSessionBinding({
        targetSessionKey: "agent:codex:acp:s1",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "thread-1",
          parentConversationId: "parent-1",
        },
      }),
    );
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:s1",
      storeSessionKey: "agent:codex:acp:s1",
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "runtime-1",
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
      },
    });

    const setModelParams = createDiscordParams("/acp set model gpt-5.3-codex", baseCfg);
    setModelParams.ctx.MessageThreadId = "thread-1";
    const setModel = await handleAcpCommand(setModelParams, true);
    expect(hoisted.setConfigOptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "model",
        value: "gpt-5.3-codex",
      }),
    );
    expect(setModel?.reply?.text).toContain("Updated ACP config option");

    hoisted.setConfigOptionMock.mockClear();
    const setCwdParams = createDiscordParams("/acp set cwd /tmp/worktree", baseCfg);
    setCwdParams.ctx.MessageThreadId = "thread-1";
    const setCwd = await handleAcpCommand(setCwdParams, true);
    expect(hoisted.setConfigOptionMock).not.toHaveBeenCalled();
    expect(setCwd?.reply?.text).toContain("Updated ACP cwd");
  });

  it("rejects non-absolute cwd values via ACP runtime option validation", async () => {
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createSessionBinding({
        targetSessionKey: "agent:codex:acp:s1",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "thread-1",
          parentConversationId: "parent-1",
        },
      }),
    );
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:s1",
      storeSessionKey: "agent:codex:acp:s1",
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "runtime-1",
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
      },
    });

    const params = createDiscordParams("/acp cwd relative/path", baseCfg);
    params.ctx.MessageThreadId = "thread-1";
    const result = await handleAcpCommand(params, true);

    expect(result?.reply?.text).toContain("ACP error (ACP_INVALID_RUNTIME_OPTION)");
    expect(result?.reply?.text).toContain("absolute path");
  });

  it("rejects invalid timeout values before backend config writes", async () => {
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createSessionBinding({
        targetSessionKey: "agent:codex:acp:s1",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "thread-1",
          parentConversationId: "parent-1",
        },
      }),
    );
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:s1",
      storeSessionKey: "agent:codex:acp:s1",
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "runtime-1",
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
      },
    });

    const params = createDiscordParams("/acp timeout 10s", baseCfg);
    params.ctx.MessageThreadId = "thread-1";
    const result = await handleAcpCommand(params, true);

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

    const params = createDiscordParams("/acp doctor", baseCfg);
    const result = await handleAcpCommand(params, true);

    expect(result?.reply?.text).toContain("ACP doctor:");
    expect(result?.reply?.text).toContain("healthy: no");
    expect(result?.reply?.text).toContain("next:");
  });

  it("shows deterministic install instructions via /acp install", async () => {
    const params = createDiscordParams("/acp install", baseCfg);
    const result = await handleAcpCommand(params, true);

    expect(result?.reply?.text).toContain("ACP install:");
    expect(result?.reply?.text).toContain("run:");
    expect(result?.reply?.text).toContain("then: /acp doctor");
  });
});
