import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../packages/gateway-protocol/src/client-info.js";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { terminalHandlers, TERMINAL_OPEN_DEADLINE_MS } from "./terminal.js";
import { makeTerminalGatewayOpts as makeOpts } from "./terminal.test-helpers.js";

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
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

vi.mock("../node-command-policy.js", () => ({
  resolveNodeCommandAllowlist: policyMocks.resolveNodeCommandAllowlist,
  isNodeCommandAllowed: policyMocks.isNodeCommandAllowed,
}));

vi.mock("../node-invoke-plugin-policy.js", () => ({
  applyPluginNodeInvokePolicy: policyMocks.applyPluginNodeInvokePolicy,
}));

function installCatalog(provider: SessionCatalogProvider) {
  const registry = createEmptyPluginRegistry();
  registry.sessionCatalogs.push({ pluginId: "test", provider, source: "test" });
  setActivePluginRegistry(registry);
}

afterEach(() => {
  resetPluginRuntimeStateForTest();
  policyMocks.resolveNodeCommandAllowlist.mockReset();
  policyMocks.isNodeCommandAllowed.mockReset().mockReturnValue({ ok: true });
  policyMocks.applyPluginNodeInvokePolicy.mockReset().mockResolvedValue(null);
});

describe("terminal gateway policy", () => {
  it("lists agent-owned sessions with their owner marker", async () => {
    const { opts, sessions, respond } = makeOpts({}, { enabled: true });
    sessions.list.mockReturnValue([
      {
        sessionId: "terminal-agent",
        agentId: "main",
        shell: "/bin/zsh",
        cwd: "/work",
        attached: true,
        owner: "agent:agent:main:main",
        createdAtMs: 42,
      },
    ]);

    await expectDefined(terminalHandlers["terminal.list"], "terminal.list")(opts);

    expect(respond).toHaveBeenCalledWith(true, {
      sessions: [
        {
          sessionId: "terminal-agent",
          agentId: "main",
          shell: "/bin/zsh",
          cwd: "/work",
          confined: false,
          attached: true,
          owner: "agent:agent:main:main",
          createdAtMs: 42,
        },
      ],
    });
  });

  it("returns the attach snapshot offset to capable clients", async () => {
    const { opts, respond } = makeOpts({ sessionId: "terminal-1" }, { enabled: true });
    opts.client!.connect.caps = [
      GATEWAY_CLIENT_CAPS.TERMINAL_OFFSET_SEQ,
      GATEWAY_CLIENT_CAPS.TERMINAL_SESSION_METADATA,
    ];

    await expectDefined(terminalHandlers["terminal.attach"], "terminal.attach")(opts);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ buffer: "replay", seq: 6, title: "codex", owner: "conn" }),
    );
  });

  it("forwards terminal close to the session manager", async () => {
    const { opts, sessions, respond } = makeOpts({ sessionId: "terminal-1" }, { enabled: true });

    await expectDefined(terminalHandlers["terminal.close"], "terminal.close")(opts);

    expect(sessions.close).toHaveBeenCalledWith("conn-1", "terminal-1");
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
  });

  it("keeps legacy protocol-4 attach replies within their closed schema", async () => {
    const { opts, respond } = makeOpts({ sessionId: "terminal-1" }, { enabled: true });

    await expectDefined(terminalHandlers["terminal.attach"], "terminal.attach")(opts);

    expect(respond).toHaveBeenCalledWith(true, {
      sessionId: "terminal-1",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
      confined: false,
      buffer: "replay",
    });
  });

  it("rejects catalog opens for missing providers", async () => {
    const { opts, sessions, respond } = makeOpts(
      {
        cols: 80,
        rows: 24,
        catalog: { catalogId: "missing", hostId: "gateway:local", threadId: "thread" },
      },
      { enabled: true },
    );
    await expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);
    expect(sessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
  });

  it.each(["selected-codex-home"])(
    "opens a provider-built local resume plan for source %s and returns its title",
    async (sourceHomeId) => {
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
      installCatalog({
        id: "codex",
        label: "Codex",
        list: async () => [],
        read: async (request) => ({
          hostId: request.hostId,
          threadId: request.threadId,
          items: [],
        }),
        openTerminal,
      });
      const { opts, sessions, respond } = makeOpts(
        {
          cols: 80,
          rows: 24,
          catalog: {
            catalogId: "codex",
            hostId: "gateway:local",
            threadId: "thread",
            ...(sourceHomeId ? { sourceHomeId } : {}),
          },
        },
        { enabled: true },
      );
      await expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);

      expect(openTerminal).toHaveBeenCalledWith({
        agentId: "main",
        allowProcessHomeFallback: false,
        hostId: "gateway:local",
        threadId: "thread",
        ...(sourceHomeId ? { sourceHomeId } : {}),
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
    },
  );

  it("rejects a catalog plan that finishes after the absolute open deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      installCatalog({
        id: "codex",
        label: "Codex",
        list: async () => [],
        read: async (request) => ({ ...request, items: [] }),
        openTerminal: async () => {
          vi.setSystemTime(TERMINAL_OPEN_DEADLINE_MS);
          return { kind: "local", argv: ["codex", "resume", "thread"] };
        },
      });
      const { opts, sessions, respond } = makeOpts(
        {
          cols: 80,
          rows: 24,
          catalog: { catalogId: "codex", hostId: "gateway:local", threadId: "thread" },
        },
        { enabled: true },
      );

      await expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);

      expect(sessions.open).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: "terminal open timed out" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not create a terminal after the owning connection closes during catalog lookup", async () => {
    const plan = createDeferred<{ kind: "local"; argv: string[] }>();
    const openTerminal = vi.fn(() => plan.promise);
    installCatalog({
      id: "codex",
      label: "Codex",
      list: async () => [],
      read: async (request) => ({ ...request, items: [] }),
      openTerminal,
    });
    const { opts, sessions, respond, isConnectionActive } = makeOpts(
      {
        cols: 80,
        rows: 24,
        catalog: { catalogId: "codex", hostId: "gateway:local", threadId: "thread" },
      },
      { enabled: true },
    );

    const opening = expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);
    await waitForFast(() => expect(openTerminal).toHaveBeenCalledOnce());
    isConnectionActive.mockReturnValue(false);
    plan.resolve({ kind: "local", argv: ["codex", "resume", "thread"] });
    await opening;

    expect(sessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "terminal connection closed" }),
    );
  });

  it("closes a terminal whose owning connection disappears during PTY creation", async () => {
    const created = createDeferred<{
      ok: true;
      sessionId: string;
      agentId: string;
      shell: string;
      cwd: string;
    }>();
    const { opts, sessions, respond, isConnectionActive } = makeOpts(
      { cols: 80, rows: 24 },
      { enabled: true },
    );
    sessions.open.mockImplementationOnce(async () => await created.promise);

    const opening = expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);
    await waitForFast(() => expect(sessions.open).toHaveBeenCalledOnce());
    isConnectionActive.mockReturnValue(false);
    created.resolve({
      ok: true,
      sessionId: "terminal-raced",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
    });
    await opening;

    expect(sessions.close).toHaveBeenCalledWith("conn-1", "terminal-raced");
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "terminal connection closed" }),
    );
  });

  it("times out one terminal open with request-scoped cancellation", async () => {
    vi.useFakeTimers();
    try {
      const created = createDeferred<{
        ok: true;
        sessionId: string;
        agentId: string;
        shell: string;
        cwd: string;
      }>();
      let openSignal: AbortSignal | undefined;
      const { opts, sessions, respond } = makeOpts({ cols: 80, rows: 24 }, { enabled: true });
      sessions.open.mockImplementationOnce(async (request: unknown) => {
        openSignal = (request as { signal?: AbortSignal }).signal;
        return await created.promise;
      });

      const opening = expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);
      await waitForFast(() => expect(openSignal).toBeDefined());
      await vi.advanceTimersByTimeAsync(TERMINAL_OPEN_DEADLINE_MS);
      await opening;

      expect(openSignal?.aborted).toBe(true);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: "terminal open timed out" }),
      );
      created.resolve({
        ok: true,
        sessionId: "terminal-late",
        agentId: "main",
        shell: "/bin/zsh",
        cwd: "/work",
      });
      await waitForFast(() =>
        expect(sessions.close).toHaveBeenCalledWith("conn-1", "terminal-late"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not create a terminal when disabled during catalog lookup", async () => {
    const plan = createDeferred<{ kind: "local"; argv: string[] }>();
    const openTerminal = vi.fn(() => plan.promise);
    installCatalog({
      id: "codex",
      label: "Codex",
      list: async () => [],
      read: async (request) => ({ ...request, items: [] }),
      openTerminal,
    });
    const { opts, sessions, respond, isTerminalEnabled } = makeOpts(
      {
        cols: 80,
        rows: 24,
        catalog: { catalogId: "codex", hostId: "gateway:local", threadId: "thread" },
      },
      { enabled: true },
    );

    const opening = expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);
    await waitForFast(() => expect(openTerminal).toHaveBeenCalledOnce());
    isTerminalEnabled.mockReturnValue(false);
    plan.resolve({ kind: "local", argv: ["codex", "resume", "thread"] });
    await opening;

    expect(sessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "terminal is disabled" }),
    );
  });

  it("uses the refreshed launch plan after catalog lookup", async () => {
    const plan = createDeferred<{ kind: "local"; argv: string[] }>();
    const openTerminal = vi.fn(() => plan.promise);
    installCatalog({
      id: "codex",
      label: "Codex",
      list: async () => [],
      read: async (request) => ({ ...request, items: [] }),
      openTerminal,
    });
    const { opts, sessions, resolveTerminalLaunchPolicy } = makeOpts(
      {
        cols: 80,
        rows: 24,
        catalog: { catalogId: "codex", hostId: "gateway:local", threadId: "thread" },
      },
      { enabled: true },
    );

    const opening = expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);
    await waitForFast(() => expect(openTerminal).toHaveBeenCalledOnce());
    resolveTerminalLaunchPolicy.mockReturnValue({
      ok: true,
      plan: { agentId: "main", cwd: process.cwd(), shell: "/bin/refreshed", args: [] },
    });
    plan.resolve({ kind: "local", argv: ["codex", "resume", "thread"] });
    await opening;

    expect(sessions.open).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: process.cwd(),
        shell: process.platform === "win32" ? "codex" : "/bin/refreshed",
      }),
    );
  });

  it("rejects a node plan when its owner node is disconnected", async () => {
    installCatalog({
      id: "claude",
      label: "Claude",
      list: async () => [],
      read: async (request) => ({
        hostId: request.hostId,
        threadId: request.threadId,
        items: [],
      }),
      openTerminal: async () => ({
        kind: "node",
        nodeId: "node-1",
        command: "anthropic.claude.terminal.resume.v1",
        paramsJSON: JSON.stringify({ threadId: "thread" }),
      }),
    });
    const { opts, sessions, respond } = makeOpts(
      {
        cols: 80,
        rows: 24,
        catalog: { catalogId: "claude", hostId: "node:node-1", threadId: "thread" },
      },
      { enabled: true },
    );
    await expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);
    expect(sessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
  });

  it("rejects a node plan denied by the node command allowlist", async () => {
    const command = "anthropic.claude.terminal.resume.v1";
    installCatalog({
      id: "claude",
      label: "Claude",
      list: async () => [],
      read: async (request) => ({ ...request, items: [] }),
      openTerminal: async () => ({
        kind: "node",
        nodeId: "node-1",
        command,
        paramsJSON: JSON.stringify({ threadId: "thread" }),
      }),
    });
    policyMocks.isNodeCommandAllowed.mockReturnValue({
      ok: false,
      reason: "command not allowlisted",
    });
    const { opts, sessions, respond } = makeOpts(
      {
        cols: 80,
        rows: 24,
        catalog: { catalogId: "claude", hostId: "node:node-1", threadId: "thread" },
      },
      { enabled: true },
      undefined,
      {
        get: () => ({ nodeId: "node-1", connId: "conn-node", commands: [command] }),
      },
    );

    await expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);

    expect(sessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "command not allowlisted" }),
    );
  });

  it("opens a normally approved node relay after generic invoke policy", async () => {
    const command = "anthropic.claude.terminal.resume.v1";
    installCatalog({
      id: "claude",
      label: "Claude",
      list: async () => [],
      read: async (request) => ({ ...request, items: [] }),
      openTerminal: async () => ({
        kind: "node",
        nodeId: "node-1",
        command,
        paramsJSON: JSON.stringify({ threadId: "thread" }),
      }),
    });
    const node = {
      nodeId: "node-1",
      connId: "conn-node",
      pairingGeneration: "generation-node",
      commands: [command],
    };
    const invoke = vi.fn((rawParams: unknown) => {
      const params = rawParams as { onDispatchReady?: (id: string) => void };
      params.onDispatchReady?.("invoke-1");
      return Promise.resolve({ ok: true });
    });
    const nodeRegistry = { get: () => node, invoke, sendInvokeInput: vi.fn() };
    const { opts, sessions } = makeOpts(
      {
        cols: 100,
        rows: 30,
        catalog: { catalogId: "claude", hostId: "node:node-1", threadId: "thread" },
      },
      { enabled: true },
      undefined,
      nodeRegistry,
    );

    await expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);

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
      installCatalog({
        id: "claude",
        label: "Claude",
        list: async () => [],
        read: async (request) => ({ ...request, items: [] }),
        openTerminal: async () => ({
          kind: "node",
          nodeId: "node-1",
          command,
          paramsJSON: JSON.stringify({ threadId: "thread" }),
        }),
      });
      let node = {
        nodeId: "node-1",
        connId: "conn-old",
        pairingGeneration: "generation-old",
        commands: [command],
      };
      const { opts, sessions, respond } = makeOpts(
        {
          cols: 80,
          rows: 24,
          catalog: { catalogId: "claude", hostId: "node:node-1", threadId: "thread" },
        },
        { enabled: true },
        undefined,
        { get: () => node },
      );

      const opening = expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);
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
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          message:
            change === "commands removed"
              ? "terminal node command is not available"
              : "terminal node connection changed; refresh the host and retry",
        }),
      );
    },
  );

  it("reports plugin invoke policy denial as unavailable", async () => {
    const command = "codex.terminal.resume.v1";
    installCatalog({
      id: "codex",
      label: "Codex",
      list: async () => [],
      read: async (request) => ({ ...request, items: [] }),
      openTerminal: async () => ({
        kind: "node",
        nodeId: "node-1",
        command,
        paramsJSON: JSON.stringify({ threadId: "thread" }),
      }),
    });
    policyMocks.applyPluginNodeInvokePolicy.mockResolvedValue({
      ok: false,
      message: "terminal resume denied",
    });
    const { opts, sessions, respond } = makeOpts(
      {
        cols: 80,
        rows: 24,
        catalog: { catalogId: "codex", hostId: "node:node-1", threadId: "thread" },
      },
      { enabled: true },
      undefined,
      { get: () => ({ nodeId: "node-1", connId: "conn-node", commands: [command] }) },
    );

    await expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);

    expect(sessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "terminal resume denied" }),
    );
  });

  it("rejects reopening after an accepted disable while restart is pending", async () => {
    const { opts, sessions, respond } = makeOpts(
      { cols: 80, rows: 24 },
      { enabled: true },
      { gateway: { terminal: { enabled: false } } },
    );

    await expectDefined(
      terminalHandlers["terminal.open"],
      'terminalHandlers["terminal.open"] test invariant',
    )(opts);

    expect(sessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
  });

  it("rejects reopening after an accepted sandbox tightening", async () => {
    const { opts, sessions, respond } = makeOpts(
      { cols: 80, rows: 24 },
      { enabled: true },
      {
        gateway: { terminal: { enabled: true } },
        agents: { defaults: { sandbox: { mode: "all" } } },
      },
    );

    await expectDefined(
      terminalHandlers["terminal.open"],
      'terminalHandlers["terminal.open"] test invariant',
    )(opts);

    expect(sessions.open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
  });

  it("closes a live session and rejects input after disablement", async () => {
    const { opts, sessions, respond } = makeOpts(
      { sessionId: "s1", data: "ls\n" },
      { enabled: false },
    );

    await expectDefined(
      terminalHandlers["terminal.input"],
      'terminalHandlers["terminal.input"] test invariant',
    )(opts);

    expect(sessions.write).not.toHaveBeenCalled();
    expect(sessions.close).toHaveBeenCalledWith("conn-1", "s1");
    expect(respond).toHaveBeenCalledWith(true, { ok: false });
  });

  it("uploads a file through the owned terminal session", async () => {
    const { opts, sessions, respond } = makeOpts(
      { sessionId: "s1", name: "report.pdf", contentBase64: "dGVzdA==" },
      { enabled: true },
    );

    await expectDefined(terminalHandlers["terminal.upload"], "terminal.upload")(opts);

    expect(sessions.upload).toHaveBeenCalledWith("conn-1", "s1", {
      name: "report.pdf",
      contentBase64: "dGVzdA==",
      assertCommitAllowed: expect.any(Function),
    });
    expect(respond).toHaveBeenCalledWith(true, { path: "/tmp/upload/report.pdf", size: 4 });
  });

  it("rejects non-canonical base64 before staging", async () => {
    const { opts, sessions, respond } = makeOpts(
      { sessionId: "s1", name: "report.pdf", contentBase64: "AB==" },
      { enabled: true },
    );

    await expectDefined(terminalHandlers["terminal.upload"], "terminal.upload")(opts);

    expect(sessions.upload).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: ErrorCodes.INVALID_REQUEST }),
    );
  });

  it.each([{ caps: [GATEWAY_CLIENT_CAPS.TERMINAL_UPLOAD_PATH_STYLE] }])(
    "only returns insertion metadata to clients advertising its capability: $caps",
    async ({ caps }: { caps: string[] }) => {
      const { opts, sessions, respond } = makeOpts(
        { sessionId: "s1", name: "report.pdf", contentBase64: "dGVzdA==" },
        { enabled: true },
      );
      expectDefined(opts.client, "authenticated upload client").connect.caps = caps;
      sessions.upload.mockResolvedValue({
        path: "/tmp/upload/report.pdf",
        size: 4,
        uploadPathStyle: "native",
      });

      await expectDefined(terminalHandlers["terminal.upload"], "terminal.upload")(opts);

      expect(respond).toHaveBeenCalledWith(true, {
        path: "/tmp/upload/report.pdf",
        size: 4,
        ...(caps.includes(GATEWAY_CLIENT_CAPS.TERMINAL_UPLOAD_PATH_STYLE)
          ? { uploadPathStyle: "native" }
          : {}),
      });
    },
  );

  it.each([undefined, "native"] as const)(
    "binds paired-node uploads and insertion style to the admitted plan: %s",
    async (uploadPathStyle) => {
      const command = "codex.terminal.resume.v1";
      const uploadCommand = "terminal.upload";
      const plan = {
        kind: "node" as const,
        nodeId: "node-1",
        command,
        paramsJSON: JSON.stringify({ threadId: "thread" }),
        uploadPathStyle,
      };
      installCatalog({
        id: "codex",
        label: "Codex",
        list: async () => [],
        read: async (request) => ({ ...request, items: [] }),
        openTerminal: async () => plan,
      });
      const node = {
        nodeId: "node-1",
        connId: "conn-node",
        pairingGeneration: "generation-node",
        commands: [command, uploadCommand],
      };
      const nodePayload = {
        path: "/tmp/node/report.pdf",
        size: 4,
        // A remote reply cannot opt an undeclared receiver into native insertion.
        ...(uploadPathStyle === undefined ? { uploadPathStyle: "native" } : {}),
      };
      const invoke = vi.fn(async () => ({ ok: true, payloadJSON: JSON.stringify(nodePayload) }));
      const { opts, sessions } = makeOpts(
        {
          cols: 80,
          rows: 24,
          catalog: { catalogId: "codex", hostId: "node:node-1", threadId: "thread" },
        },
        { enabled: true },
        undefined,
        { get: () => node, invoke },
      );

      await expectDefined(terminalHandlers["terminal.open"], "terminal.open")(opts);
      plan.nodeId = "node-2";
      plan.uploadPathStyle = uploadPathStyle === undefined ? "native" : undefined;
      const openRequest = sessions.open.mock.calls[0]?.[0] as
        | { stageUpload?: (file: { name: string; contentBase64: string }) => Promise<unknown> }
        | undefined;
      const result = await openRequest?.stageUpload?.({
        name: "report.pdf",
        contentBase64: "dGVzdA==",
      });

      expect(invoke).toHaveBeenCalledWith({
        nodeId: "node-1",
        expectedConnId: "conn-node",
        expectedPairingGeneration: "generation-node",
        command: uploadCommand,
        params: { name: "report.pdf", contentBase64: "dGVzdA==" },
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
