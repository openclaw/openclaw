import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../packages/gateway-protocol/src/client-info.js";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { createTerminalLaunchPolicy } from "../terminal/launch.js";
import { TerminalSessionManager } from "../terminal/session-manager.js";
import { makeFakePty } from "../terminal/session-manager.test-helpers.js";
import { openTerminalSession, terminalHandlers, TERMINAL_OPEN_DEADLINE_MS } from "./terminal.js";
import { makeTerminalSessionMocks } from "./terminal.test-helpers.js";

function waitForFast<T>(callback: () => T | Promise<T>) {
  return vi.waitFor(callback, { interval: 1 });
}

const policyMocks = vi.hoisted(() => ({
  resolveNodeCommandAllowlist: vi.fn(() => new Set<string>()),
  isNodeCommandAllowed: vi.fn<() => { ok: true } | { ok: false; reason: string }>(() => ({
    ok: true,
  })),
  applyPluginNodeInvokePolicy: vi.fn<() => Promise<{ ok: false; message: string } | null>>(
    async () => null,
  ),
}));
const sessionMocks = vi.hoisted(() => ({
  loadGatewaySessionEntryReadOnly: vi.fn(
    (
      _sessionKey: string,
      _opts?: unknown,
    ): {
      entry?: Pick<InternalSessionEntry, "sessionId" | "pendingProjectGitUrl" | "pendingWorktree">;
    } => ({
      entry: { sessionId: "ui-session-id" },
    }),
  ),
}));

vi.mock("../node-command-policy.js", () => ({
  resolveNodeCommandAllowlist: policyMocks.resolveNodeCommandAllowlist,
  isNodeCommandAllowed: policyMocks.isNodeCommandAllowed,
}));

vi.mock("../node-invoke-plugin-policy.js", () => ({
  applyPluginNodeInvokePolicy: policyMocks.applyPluginNodeInvokePolicy,
}));

vi.mock("../session-utils.js", async () => ({
  ...(await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js")),
  loadGatewaySessionEntryReadOnlyAsync: sessionMocks.loadGatewaySessionEntryReadOnly,
}));

vi.mock("../session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils-store-worker.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: async (params: { key: string; agentId?: string }) =>
    sessionMocks.loadGatewaySessionEntryReadOnly(params.key, { agentId: params.agentId }),
}));

function makeOpts(
  params: Record<string, unknown> = { cols: 80, rows: 24 },
  {
    enabled = true,
    preparedConfig,
    nodeRegistry = { get: () => undefined },
  }: {
    enabled?: boolean;
    preparedConfig?: OpenClawConfig;
    nodeRegistry?: {
      get: (nodeId: string) => unknown;
      invoke?: (params: unknown) => Promise<unknown>;
    };
  } = {},
) {
  const sessions = makeTerminalSessionMocks();
  const runtimeConfig: OpenClawConfig = { gateway: { terminal: { enabled } } };
  const policy = createTerminalLaunchPolicy(runtimeConfig);
  if (preparedConfig) {
    policy.prepareConfig(preparedConfig, { restartPending: true });
  }
  const respond = vi.fn();
  const isConnectionActive = vi.fn(() => true);
  const isTerminalEnabled = vi.fn(() => policy.isEnabled());
  const resolveTerminalLaunchPolicy = vi.fn((agentId?: string) => policy.resolve(agentId));
  const context = {
    getRuntimeConfig: () => runtimeConfig,
    resolveTerminalLaunchPolicy,
    isTerminalEnabled,
    terminalSessions: sessions,
    nodeRegistry: { invoke: vi.fn(), ...nodeRegistry },
    isConnectionActive,
    logGateway: { info: vi.fn() },
  } as unknown as Parameters<(typeof terminalHandlers)["terminal.input"]>[0]["context"];
  const opts = {
    params,
    respond,
    context,
    client: { connId: "conn-1", connect: {} },
  } as unknown as Parameters<(typeof terminalHandlers)["terminal.input"]>[0];
  return {
    opts,
    sessions,
    respond,
    isConnectionActive,
    isTerminalEnabled,
    resolveTerminalLaunchPolicy,
  };
}

type OpenTerminal = NonNullable<SessionCatalogProvider["openTerminal"]>;
function installTerminalCatalog(openTerminal: OpenTerminal, id = "codex") {
  const provider: SessionCatalogProvider = {
    id,
    label: id,
    list: async () => [],
    read: async (request) => ({ ...request, items: [] }),
    openTerminal,
  };
  const registry = createEmptyPluginRegistry();
  registry.sessionCatalogs.push({ pluginId: "test", provider, source: "test" });
  setActivePluginRegistry(registry);
}

function catalogParams(catalogId = "codex", hostId = "gateway:local") {
  return { cols: 80, rows: 24, catalog: { catalogId, hostId, threadId: "thread" } };
}

const localPlan = () => ({ kind: "local" as const, argv: ["codex", "resume", "thread"] });
function nodePlan(command: string) {
  return {
    kind: "node" as const,
    nodeId: "node-1",
    command,
    paramsJSON: JSON.stringify({ threadId: "thread" }),
  };
}

function nodeSession(
  command: string,
  overrides: { connId?: string; pairingGeneration?: string } = {},
) {
  return {
    nodeId: "node-1",
    connId: "conn-node",
    pairingGeneration: "generation-node",
    commands: [command],
    ...overrides,
  };
}

async function startCatalogLookup() {
  const plan = createDeferred<ReturnType<typeof localPlan>>();
  const openTerminal = vi.fn(() => plan.promise);
  installTerminalCatalog(openTerminal);
  const fixture = makeOpts(catalogParams());
  const opening = runTerminal("terminal.open", fixture.opts);
  await waitForFast(() => expect(openTerminal).toHaveBeenCalledOnce());
  return { ...fixture, plan, opening };
}

function openOwnedTerminal(opts: ReturnType<typeof makeOpts>["opts"], sessionKey: string) {
  return openTerminalSession(opts, { agentId: "main", sessionKey, cols: 80, rows: 24 });
}

function runTerminal(method: string, opts: ReturnType<typeof makeOpts>["opts"]) {
  return expectDefined(terminalHandlers[method], method)(opts);
}

function expectFailure(respond: ReturnType<typeof vi.fn>, error: Record<string, unknown>) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(error));
}

async function expectOpenFailure(
  { opts, sessions, respond }: ReturnType<typeof makeOpts>,
  error: Record<string, unknown> = {},
) {
  await runTerminal("terminal.open", opts);
  expect(sessions.open).not.toHaveBeenCalled();
  expectFailure(respond, error);
}

const uploadFile = { name: "report.pdf", contentBase64: "dGVzdA==" };

function openedTerminal(sessionId: string) {
  return { ok: true as const, sessionId, agentId: "main", shell: "/bin/zsh", cwd: "/work" };
}

afterEach(() => {
  vi.useRealTimers();
  resetPluginRuntimeStateForTest();
  policyMocks.resolveNodeCommandAllowlist.mockReset();
  policyMocks.isNodeCommandAllowed.mockReset().mockReturnValue({ ok: true });
  policyMocks.applyPluginNodeInvokePolicy.mockReset().mockResolvedValue(null);
  sessionMocks.loadGatewaySessionEntryReadOnly.mockReset().mockReturnValue({
    entry: { sessionId: "ui-session-id" },
  });
});

describe("terminal gateway policy", () => {
  it("rejects Gateway-local catalog terminals before the provider can prepare a shell", async () => {
    const openTerminal = vi.fn(async () => localPlan());
    installTerminalCatalog(openTerminal);
    const { opts, respond } = makeOpts(catalogParams());
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      disableGatewayLocalTerminals: true,
    });
    opts.context.terminalSessions = manager;
    try {
      await runTerminal("terminal.open", opts);
      expect(openTerminal).not.toHaveBeenCalled();
      expectFailure(respond, {
        code: ErrorCodes.UNAVAILABLE,
        message: expect.stringContaining("contact the Gateway deployment administrator"),
      });
    } finally {
      manager.disposeAll();
    }
  });

  it("binds a UI terminal to its exact agent session while keeping the UI attached", async () => {
    const backend = makeFakePty();
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: async () => backend });
    const agentSessionKey = "agent:main:ui-session";
    const agentOwner = {
      kind: "agent",
      agentSessionKey,
      agentSessionId: "ui-session-id",
      agentId: "main",
    } as const;
    const { opts, respond } = makeOpts({});
    opts.context.terminalSessions = manager;

    await openOwnedTerminal(opts, agentSessionKey);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ agentId: "main", sessionId: expect.any(String) }),
    );
    const owned = manager.listAgent(agentOwner);
    expect(owned).toHaveLength(1);
    const session = expectDefined(owned[0], "session-owned UI terminal");
    expect(session).toMatchObject({ attached: true, owner: `agent:${agentSessionKey}` });
    expect(manager.write("conn-1", session.sessionId, "operator input\n")).toBe(true);

    backend.emitData("ui session output");
    expect(manager.snapshotAgent(agentOwner, session.sessionId)).toContain("ui session output");
    expect(
      manager.listAgent({ ...agentOwner, agentSessionKey: "agent:main:other-session" }),
    ).toEqual([]);
    expect(
      manager.snapshotAgent({ ...agentOwner, agentId: "research" }, session.sessionId),
    ).toBeUndefined();
    expect(sessionMocks.loadGatewaySessionEntryReadOnly).toHaveBeenCalledWith(agentSessionKey, {
      agentId: "main",
    });
  });

  it.each([
    { state: "is missing", entry: undefined, error: { code: ErrorCodes.UNAVAILABLE } },
    {
      state: "awaits worktree preparation",
      entry: {
        sessionId: "ui-session-id",
        pendingWorktree: {
          workspace: "/tmp/project",
          titleSource: "Prepare workspace",
        },
      },
      error: {
        code: ErrorCodes.INVALID_REQUEST,
        message:
          'Session "agent:main:pending" workspace is not ready. Wait for setup to finish or retry in chat.',
      },
    },
  ])("rejects UI ownership when the session $state", async ({ entry, error }) => {
    sessionMocks.loadGatewaySessionEntryReadOnly.mockReturnValue({ entry });
    const { opts, sessions, respond } = makeOpts({});

    await openOwnedTerminal(opts, "agent:main:pending");

    expect(sessions.open).not.toHaveBeenCalled();
    expectFailure(respond, error);
  });

  it("lists agent-owned sessions with their owner marker", async () => {
    const { opts, sessions, respond } = makeOpts({});
    const listed = {
      sessionId: "terminal-agent",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
      attached: true,
      owner: "agent:agent:main:main" as const,
      createdAtMs: 42,
    };
    sessions.list.mockReturnValue([listed]);

    await runTerminal("terminal.list", opts);

    expect(respond).toHaveBeenCalledWith(true, {
      sessions: [{ ...listed, confined: false }],
    });
  });

  it.each([false, true])(
    "attaches within the advertised metadata schema (capable=%s)",
    async (capable) => {
      const { opts, respond } = makeOpts({ sessionId: "terminal-1" });
      if (capable) {
        opts.client!.connect.caps = [
          GATEWAY_CLIENT_CAPS.TERMINAL_OFFSET_SEQ,
          GATEWAY_CLIENT_CAPS.TERMINAL_SESSION_METADATA,
        ];
      }
      await runTerminal("terminal.attach", opts);
      expect(respond).toHaveBeenCalledWith(
        true,
        capable
          ? expect.objectContaining({ buffer: "replay", seq: 6, title: "codex", owner: "conn" })
          : {
              sessionId: "terminal-1",
              agentId: "main",
              shell: "/bin/zsh",
              cwd: "/work",
              confined: false,
              buffer: "replay",
            },
      );
    },
  );

  it("forwards terminal close to the session manager", async () => {
    const { opts, sessions, respond } = makeOpts({ sessionId: "terminal-1" });

    await runTerminal("terminal.close", opts);

    expect(sessions.close).toHaveBeenCalledWith("conn-1", "terminal-1");
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
  });

  it("rejects catalog opens for missing providers", async () => {
    await expectOpenFailure(makeOpts(catalogParams("missing")));
  });

  it("reports a missing explicit owner as invalid request", async () => {
    const fixture = makeOpts();
    fixture.resolveTerminalLaunchPolicy.mockReturnValue({
      ok: false,
      block: { kind: "owner-required", message: "terminal requires an explicit owner" },
    });

    await expectOpenFailure(fixture, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "terminal requires an explicit owner",
    });
  });

  it("opens a provider-built local resume plan for a selected source and returns its title", async () => {
    const sourceHomeId = "selected-codex-home";
    const openTerminal = vi.fn(async () => ({
      kind: "local" as const,
      argv: ["codex", "resume", "thread"],
      env: {
        CODEX_HOME: "/agent/codex-home",
        ComSpec: "C:\\Windows\\System32\\ambient-cmd.exe",
        COMSPEC: "C:\\Windows\\System32\\configured-cmd.exe",
      },
      pathEnv: "/login-shell/bin:/usr/bin",
      title: "codex resume thread",
    }));
    installTerminalCatalog(openTerminal);
    const { opts, sessions, respond } = makeOpts({
      ...catalogParams(),
      catalog: { ...catalogParams().catalog, sourceHomeId },
    });
    await runTerminal("terminal.open", opts);

    expect(openTerminal).toHaveBeenCalledWith({
      agentId: "main",
      allowProcessHomeFallback: false,
      hostId: "gateway:local",
      threadId: "thread",
      sourceHomeId,
    });
    expect(sessions.open).toHaveBeenCalledWith(
      expect.objectContaining({
        shell: expect.any(String),
        args:
          process.platform === "win32"
            ? ["resume", "thread"]
            : ["-il", "-c", "'codex' 'resume' 'thread'"],
        env: expect.objectContaining({
          CODEX_HOME: "/agent/codex-home",
          PATH: "/login-shell/bin:/usr/bin",
        }),
      }),
    );
    if (process.platform === "win32") {
      const terminalEnv = sessions.open.mock.calls[0]?.[0] as { env: Record<string, string> };
      expect(
        Object.entries(terminalEnv.env).filter(([key]) => key.toUpperCase() === "COMSPEC"),
      ).toEqual([["COMSPEC", "C:\\Windows\\System32\\configured-cmd.exe"]]);
    }
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ sessionId: "terminal-1", title: "codex resume thread" }),
    );
  });

  it.each([
    ["isConnectionActive", "terminal connection closed"],
    ["isTerminalEnabled", "terminal is disabled"],
  ] as const)(
    "does not create a terminal after %s changes during catalog lookup",
    async (flag, message) => {
      const fixture = await startCatalogLookup();
      const { plan, opening, sessions, respond } = fixture;
      fixture[flag].mockReturnValue(false);
      plan.resolve(localPlan());
      await opening;
      expect(sessions.open).not.toHaveBeenCalled();
      expectFailure(respond, { message });
    },
  );

  it("closes a terminal whose owning connection disappears during PTY creation", async () => {
    const created = createDeferred<ReturnType<typeof openedTerminal>>();
    const { opts, sessions, respond, isConnectionActive } = makeOpts();
    sessions.open.mockImplementationOnce(async () => await created.promise);

    const opening = runTerminal("terminal.open", opts);
    await waitForFast(() => expect(sessions.open).toHaveBeenCalledOnce());
    isConnectionActive.mockReturnValue(false);
    created.resolve(openedTerminal("terminal-raced"));
    await opening;

    expect(sessions.close).toHaveBeenCalledWith("conn-1", "terminal-raced");
    expectFailure(respond, { message: "terminal connection closed" });
  });

  it("times out one terminal open with request-scoped cancellation", async () => {
    vi.useFakeTimers();
    const created = createDeferred<ReturnType<typeof openedTerminal>>();
    let openSignal: AbortSignal | undefined;
    const { opts, sessions, respond } = makeOpts();
    sessions.open.mockImplementationOnce(async (request: unknown) => {
      openSignal = (request as { signal?: AbortSignal }).signal;
      return await created.promise;
    });

    const opening = runTerminal("terminal.open", opts);
    await waitForFast(() => expect(openSignal).toBeDefined());
    await vi.advanceTimersByTimeAsync(TERMINAL_OPEN_DEADLINE_MS);
    await opening;

    expect(openSignal?.aborted).toBe(true);
    expectFailure(respond, { message: "terminal open timed out" });
    created.resolve(openedTerminal("terminal-late"));
    await waitForFast(() => expect(sessions.close).toHaveBeenCalledWith("conn-1", "terminal-late"));
  });

  it("uses the refreshed launch plan after catalog lookup", async () => {
    const { plan, opening, sessions, resolveTerminalLaunchPolicy } = await startCatalogLookup();
    resolveTerminalLaunchPolicy.mockReturnValue({
      ok: true,
      plan: { agentId: "main", cwd: process.cwd(), shell: "/bin/refreshed", args: [] },
    });
    plan.resolve(localPlan());
    await opening;

    expect(sessions.open).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: process.cwd(),
        shell: process.platform === "win32" ? "codex" : "/bin/refreshed",
      }),
    );
  });

  it.each([
    { stage: "disconnected", catalogId: "claude", message: "" },
    { stage: "allowlist", catalogId: "claude", message: "command not allowlisted" },
    { stage: "plugin", catalogId: "codex", message: "terminal resume denied" },
  ])("rejects a node plan blocked by $stage", async ({ stage, catalogId, message }) => {
    const command =
      catalogId === "claude" ? "anthropic.claude.terminal.resume.v1" : "codex.terminal.resume.v1";
    installTerminalCatalog(async () => nodePlan(command), catalogId);
    if (stage === "allowlist") {
      policyMocks.isNodeCommandAllowed.mockReturnValue({ ok: false, reason: message });
    } else if (stage === "plugin") {
      policyMocks.applyPluginNodeInvokePolicy.mockResolvedValue({ ok: false, message });
    }
    await expectOpenFailure(
      makeOpts(catalogParams(catalogId, "node:node-1"), {
        nodeRegistry: { get: () => (stage === "disconnected" ? undefined : nodeSession(command)) },
      }),
      message ? { message } : {},
    );
  });

  it("opens a normally approved node relay after generic invoke policy", async () => {
    const command = "anthropic.claude.terminal.resume.v1";
    installTerminalCatalog(async () => nodePlan(command), "claude");
    const node = nodeSession(command);
    const invoke = vi.fn((rawParams: unknown) => {
      const params = rawParams as { onDispatchReady?: (id: string) => void };
      params.onDispatchReady?.("invoke-1");
      return Promise.resolve({ ok: true });
    });
    const nodeRegistry = { get: () => node, invoke, sendInvokeInput: vi.fn() };
    const { opts, sessions } = makeOpts(
      { ...catalogParams("claude", "node:node-1"), cols: 100, rows: 30 },
      { nodeRegistry },
    );

    await runTerminal("terminal.open", opts);

    expect(policyMocks.resolveNodeCommandAllowlist).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ nodeId: "node-1", approvedCommands: [command] }),
    );
    expect(policyMocks.applyPluginNodeInvokePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeSession: node,
        command,
        params: { threadId: "thread", cols: 100, rows: 30 },
      }),
    );
    expect(sessions.open).toHaveBeenCalledOnce();
    const openRequest = (
      sessions.open.mock.calls.at(0) as unknown as
        | [{ createBackend?: () => Promise<unknown> }]
        | undefined
    )?.at(0);
    await openRequest?.createBackend?.();
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "node-1",
        expectedConnId: "conn-node",
        expectedPairingGeneration: "generation-node",
      }),
    );
  });

  it.each(["commands removed", "connection replaced", "pairing promoted"])(
    "rejects a changed node admission: %s",
    async (change) => {
      const command = "anthropic.claude.terminal.resume.v1";
      const policy = createDeferred<null>();
      policyMocks.applyPluginNodeInvokePolicy.mockImplementationOnce(() => policy.promise);
      installTerminalCatalog(async () => nodePlan(command), "claude");
      let node = nodeSession(command, { connId: "conn-old", pairingGeneration: "generation-old" });
      const { opts, sessions, respond } = makeOpts(catalogParams("claude", "node:node-1"), {
        nodeRegistry: { get: () => node },
      });

      const opening = runTerminal("terminal.open", opts);
      await waitForFast(() =>
        expect(policyMocks.applyPluginNodeInvokePolicy).toHaveBeenCalledOnce(),
      );
      if (change === "pairing promoted") {
        node.pairingGeneration = "generation-new";
      } else {
        node = {
          ...node,
          connId: "conn-new",
          commands: change === "commands removed" ? [] : [command],
        };
      }
      policy.resolve(null);
      await opening;

      expect(sessions.open).not.toHaveBeenCalled();
      expectFailure(respond, {
        message:
          change === "commands removed"
            ? "terminal node command is not available"
            : "terminal node connection changed; refresh the host and retry",
      });
    },
  );

  it.each([
    { gateway: { terminal: { enabled: false } } },
    {
      gateway: { terminal: { enabled: true } },
      agents: { defaults: { sandbox: { mode: "all" } } },
    },
  ] satisfies OpenClawConfig[])(
    "rejects reopening after an accepted policy tightening: %j",
    async (preparedConfig) => {
      await expectOpenFailure(makeOpts(undefined, { preparedConfig }));
    },
  );

  it("closes a live session and rejects input after disablement", async () => {
    const { opts, sessions, respond } = makeOpts(
      { sessionId: "s1", data: "ls\n" },
      { enabled: false },
    );

    await runTerminal("terminal.input", opts);

    expect(sessions.write).not.toHaveBeenCalled();
    expect(sessions.close).toHaveBeenCalledWith("conn-1", "s1");
    expect(respond).toHaveBeenCalledWith(true, { ok: false });
  });

  it.each([false, true])(
    "uploads through the owned session with advertised path style (capable=%s)",
    async (capable) => {
      const { opts, sessions, respond } = makeOpts({ sessionId: "s1", ...uploadFile });
      const result = {
        path: "/tmp/upload/report.pdf",
        size: 4,
        ...(capable ? { uploadPathStyle: "native" as const } : {}),
      };
      if (capable) {
        expectDefined(opts.client, "authenticated upload client").connect.caps = [
          GATEWAY_CLIENT_CAPS.TERMINAL_UPLOAD_PATH_STYLE,
        ];
        sessions.upload.mockResolvedValue(result);
      }
      await runTerminal("terminal.upload", opts);
      expect(sessions.upload).toHaveBeenCalledWith("conn-1", "s1", {
        ...uploadFile,
        assertCommitAllowed: expect.any(Function),
      });
      expect(respond).toHaveBeenCalledWith(true, result);
    },
  );

  it("rejects non-canonical base64 before staging", async () => {
    const { opts, sessions, respond } = makeOpts({
      ...uploadFile,
      sessionId: "s1",
      contentBase64: "AB==",
    });

    await runTerminal("terminal.upload", opts);

    expect(sessions.upload).not.toHaveBeenCalled();
    expectFailure(respond, { code: ErrorCodes.INVALID_REQUEST });
  });

  it.each([undefined, "native"] as const)(
    "binds paired-node uploads and insertion style to the admitted plan: %s",
    async (uploadPathStyle) => {
      const command = "codex.terminal.resume.v1";
      const uploadCommand = "terminal.upload";
      const plan = { ...nodePlan(command), uploadPathStyle };
      installTerminalCatalog(async () => plan);
      const node = { ...nodeSession(command), commands: [command, uploadCommand] };
      const nodePayload = {
        path: "/tmp/node/report.pdf",
        size: 4,
        // A remote reply cannot opt an undeclared receiver into native insertion.
        ...(uploadPathStyle === undefined ? { uploadPathStyle: "native" } : {}),
      };
      const invoke = vi.fn(async () => ({ ok: true, payloadJSON: JSON.stringify(nodePayload) }));
      const { opts, sessions } = makeOpts(catalogParams("codex", "node:node-1"), {
        nodeRegistry: { get: () => node, invoke },
      });

      await runTerminal("terminal.open", opts);
      plan.nodeId = "node-2";
      plan.uploadPathStyle = uploadPathStyle === undefined ? "native" : undefined;
      const openRequest = sessions.open.mock.calls[0]?.[0] as
        | { stageUpload?: (file: { name: string; contentBase64: string }) => Promise<unknown> }
        | undefined;
      const result = await openRequest?.stageUpload?.(uploadFile);

      expect(invoke).toHaveBeenCalledWith({
        nodeId: "node-1",
        expectedConnId: "conn-node",
        expectedPairingGeneration: "generation-node",
        command: uploadCommand,
        params: uploadFile,
        isDispatchAuthorized: expect.any(Function),
        timeoutMs: 120_000,
      });
      expect(result).toEqual({
        path: "/tmp/node/report.pdf",
        size: 4,
        ...(uploadPathStyle ? { uploadPathStyle } : {}),
      });
    },
  );
});
