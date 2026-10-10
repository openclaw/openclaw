import childProcess, { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import {
  bindPluginRegistryRuntime,
  call,
  conversationBindingMocks,
  createPluginRuntime,
  createSessionCatalogTestContext,
  hoisted,
  provider,
  resetSessionCatalogTestState,
  resolveRegisteredCatalogCreateTarget,
  sessionCatalogHandlers,
  setSessionCatalogEntries,
  startCall,
  type PluginRegistry,
} from "./session-catalog.test-helpers.js";

const { default: sessionSharePlugin } = await loadBundledPluginFacade<{
  default: { register: (api: OpenClawPluginApi) => void };
}>({ pluginId: "session-share", artifactBasename: "index.js" });

describe("session catalog Gateway methods", () => {
  beforeEach(resetSessionCatalogTestState);

  it("prepares the login-shell PATH before synchronous catalog availability checks", async () => {
    let finishProbe: (() => void) | undefined;
    type ShellProcess = childProcess.ChildProcessByStdio<null, PassThrough, PassThrough>;
    type ShellSpawnOptions = childProcess.SpawnOptionsWithStdioTuple<"ignore", "pipe", "pipe">;
    const asyncExec = vi.fn<
      (command: string, args: readonly string[], options: ShellSpawnOptions) => ShellProcess
    >(() => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdio: ShellProcess["stdio"] = [null, stdout, stderr, null, null];
      const child = Object.assign(new ChildProcess(), { stdin: null, stdout, stderr, stdio });
      finishProbe = () => {
        child.stdout?.emit("data", Buffer.from("\0PATH=/catalog/bin\0"));
        child.emit("close", 0, null);
      };
      return child;
    });
    const syncExec = vi.fn<typeof childProcess.execFileSync>(() => {
      throw new Error("catalog request blocked on synchronous shell probe");
    });
    vi.doMock("node:child_process", () => ({
      ...childProcess,
      spawn: asyncExec,
      execFileSync: syncExec,
    }));
    vi.resetModules();
    const shell = await vi.importActual<typeof import("../../infra/shell-env.js")>(
      "../../infra/shell-env.js",
    );
    const options = { env: process.env, platform: "linux" as const };
    hoisted.prepareShellPathFromLoginShell.mockImplementation(() =>
      shell.prepareShellPathFromLoginShell(options),
    );
    const list = vi.fn(async () => {
      expect(shell.getShellPathFromLoginShell(options)).toBe("/catalog/bin");
      return [];
    });
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("local", { list }) }];
    const pending = call("sessions.catalog.list", {});
    try {
      expect(list).not.toHaveBeenCalled();
      expect(asyncExec).toHaveBeenCalledOnce();
      finishProbe?.();
      const respond = await pending;
      expect(respond).toHaveBeenCalledWith(true, {
        catalogs: [expect.objectContaining({ id: "local", hosts: [] })],
      });
      expect(list).toHaveBeenCalledOnce();
      expect(syncExec).not.toHaveBeenCalled();
    } finally {
      finishProbe?.();
      await pending;
      vi.doUnmock("node:child_process");
    }
  });

  it("returns catalog metadata without listing providers or acquiring session projection", async () => {
    const list = vi.fn(async () => []);
    const createListOperation = vi.fn(() => {
      throw new Error("history unavailable");
    });
    hoisted.activeRegistry.sessionCatalogs = [
      { provider: provider("zeta", { createListOperation }) },
      {
        provider: provider("alpha", {
          list,
          resolveCreateSession: () => ({ model: "openai/gpt-5.6-sol", agentRuntime: "codex" }),
          startTerminalSession: async ({ cwd }) => ({ kind: "local", argv: ["codex"], cwd }),
        }),
      },
    ];
    const config = {};
    const expected = {
      catalogs: [
        {
          id: "alpha",
          label: "ALPHA",
          capabilities: {
            continueSession: false,
            archive: false,
            startTerminal: true,
            createSession: { model: "openai/gpt-5.6-sol", startTerminal: true },
          },
          hosts: [],
        },
        {
          id: "zeta",
          label: "ZETA",
          capabilities: { continueSession: false, archive: false },
          hosts: [],
        },
      ],
    };

    const readProjection = vi.fn(() => {
      throw new Error("metadata must not acquire the session projection");
    });
    const broadcastToConnIds = vi.fn();
    const context = bindSessionRowProjection(
      { getRuntimeConfig: () => config, broadcastToConnIds },
      readProjection,
    );
    const metadata = vi.fn();
    const readMetadata = () =>
      sessionCatalogHandlers["sessions.catalog.list"]!({
        params: { metadataOnly: true, progressId: "metadata-progress" },
        context,
        respond: metadata,
        client: { connId: "metadata-client" },
      } as never);
    await readMetadata();
    expect(list).not.toHaveBeenCalled();
    expect(createListOperation).not.toHaveBeenCalled();
    expect(readProjection).not.toHaveBeenCalled();
    expect(broadcastToConnIds).not.toHaveBeenCalled();
    expect(metadata).toHaveBeenCalledWith(true, expected);

    const full = await call("sessions.catalog.list", {}, config);
    expect(list).toHaveBeenCalledOnce();
    expect(createListOperation).toHaveBeenCalledOnce();
    expect(full).toHaveBeenCalledWith(true, {
      catalogs: [
        expected.catalogs[0],
        {
          ...expected.catalogs[1],
          error: { code: "catalog_error", message: "history unavailable" },
        },
      ],
    });

    metadata.mockClear();
    await readMetadata();
    expect(metadata).toHaveBeenCalledWith(true, expected);
    expect(readProjection).not.toHaveBeenCalled();
    expect(broadcastToConnIds).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledOnce();
    expect(createListOperation).toHaveBeenCalledOnce();
  });

  it("keeps metadata selection bound to the current catalog registry and agent", async () => {
    const first = provider("alpha");
    hoisted.activeRegistry.sessionCatalogs = [{ provider: first }, { provider: provider("beta") }];
    const config = { agents: { ownership: "explicit", entries: { main: {} } } };
    const params = { agentId: "main", catalogId: "alpha", metadataOnly: true };
    const selected = await call("sessions.catalog.list", params, config);
    expect(selected).toHaveBeenCalledWith(true, {
      catalogs: [expect.objectContaining({ id: "alpha", label: "ALPHA", hosts: [] })],
    });

    hoisted.activeRegistry.sessionCatalogs = [
      { provider: provider("alpha", { label: "New label" }) },
    ];
    const refreshed = await call("sessions.catalog.list", params, config);
    expect(refreshed).toHaveBeenCalledWith(true, {
      catalogs: [expect.objectContaining({ id: "alpha", label: "New label", hosts: [] })],
    });

    const unknownAgent = await call(
      "sessions.catalog.list",
      { ...params, agentId: "missing" },
      config,
    );
    expect(unknownAgent).toHaveBeenCalledWith(false, undefined, {
      code: ErrorCodes.INVALID_REQUEST,
      message: 'unknown agent id "missing"',
    });
    hoisted.activeRegistry.sessionCatalogs = [];
    const retired = await call("sessions.catalog.list", params, config);
    expect(retired).toHaveBeenCalledWith(false, undefined, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "unknown session catalog: alpha",
    });
    expect(first.list).not.toHaveBeenCalled();
  });

  it("sorts catalogs and isolates provider failures", async () => {
    hoisted.activeRegistry.sessionCatalogs = [
      { provider: provider("zeta") },
      {
        provider: provider("alpha", {
          list: vi.fn(async () => {
            throw new Error();
          }),
        }),
      },
    ];
    const respond = await call("sessions.catalog.list", {});
    expect(respond).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({
          id: "alpha",
          hosts: [],
          error: { code: "catalog_error", message: "session catalog provider failed" },
        }),
        expect.objectContaining({ id: "zeta", hosts: [] }),
      ],
    });
  });

  it("forwards one explicit multi-agent owner through list, read, continue, and archive", async () => {
    const host = {
      hostId: "gateway:local",
      label: "Local Codex",
      kind: "gateway" as const,
      connected: true,
      sessions: [
        {
          threadId: "thread-beta",
          status: "stored",
          archived: false,
          canContinue: true,
          canArchive: true,
        },
      ],
    };
    const list = vi.fn(async (_request: { agentId?: string }) => [host]);
    const read = vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }));
    const continueSession = vi.fn(async () => ({ sessionKey: "agent:beta:continued" }));
    const archive = vi.fn(async () => ({ ok: true as const }));
    hoisted.activeRegistry.sessionCatalogs = [
      { provider: provider("codex", { list, read, continueSession, archive }) },
    ];
    const config = {
      agents: {
        ownership: "explicit",
        entries: { alpha: {}, beta: {} },
      },
    };
    const locator = {
      catalogId: "codex",
      hostId: "gateway:local",
      threadId: "thread-beta",
      agentId: "beta",
    };

    await call("sessions.catalog.list", { catalogId: "codex", agentId: "beta" }, config);
    await call("sessions.catalog.read", locator, config);
    await call("sessions.catalog.continue", locator, config);
    await call("sessions.catalog.archive", { ...locator, confirmNoOtherRunner: true }, config);

    for (const [request] of list.mock.calls) {
      expect(request).toEqual(expect.objectContaining({ agentId: "beta" }));
    }
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ agentId: "beta" }));
    expect(continueSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "beta", clientScopes: [] }),
    );
    expect(archive).toHaveBeenCalledWith(expect.objectContaining({ agentId: "beta" }));
  });

  it("keeps differently ordered host filters distinct when sharing lists", async () => {
    const observedHostIds: Array<string[] | undefined> = [];
    const list = vi.fn(async ({ hostIds }: { hostIds?: string[] }) => {
      observedHostIds.push(hostIds ? [...hostIds] : undefined);
      return [];
    });
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("codex", { list }) }];
    const config = {};

    await Promise.all([
      call("sessions.catalog.list", { hostIds: ["host-a", "host-b"] }, config),
      call("sessions.catalog.list", { hostIds: ["host-b", "host-a"] }, config),
    ]);

    expect(list).toHaveBeenCalledTimes(2);
    expect(observedHostIds).toEqual([
      ["host-a", "host-b"],
      ["host-b", "host-a"],
    ]);
  });

  it("serves changed resident provider rows on the next identical list", async () => {
    const session = {
      threadId: "external-thread",
      status: "stored",
      archived: false,
      canContinue: false,
      canArchive: false,
    };
    let sessions: (typeof session)[] = [];
    const list = vi.fn(async () => [
      {
        hostId: "gateway:local",
        label: "Local",
        kind: "gateway" as const,
        connected: true,
        sessions,
      },
    ]);
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("codex", { list }) }];
    const config = {};
    const client = { connId: "resident-requester" };
    const before = await call("sessions.catalog.list", {}, config, client);
    expect(before.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toEqual([]);

    sessions = [session];
    const after = await call("sessions.catalog.list", {}, config, client);
    expect(after.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toEqual([session]);
  });

  it("projects authoritative creator ownership onto streamed and final catalog rows", async () => {
    const broadcastToConnIds = vi.fn();
    const host = {
      hostId: "gateway:local",
      label: "Local Claude",
      kind: "gateway" as const,
      connected: true,
      sessions: [
        {
          threadId: "owned-thread",
          status: "stored",
          archived: false,
          sessionKey: "agent:main:owned",
          createdActor: { type: "human" as const, id: "provider-spoof" },
          canContinue: true,
          canArchive: false,
        },
        {
          threadId: "missing-thread",
          status: "stored",
          archived: false,
          sessionKey: "agent:main:missing",
          createdActor: { type: "human" as const, id: "provider-spoof" },
          canContinue: true,
          canArchive: false,
        },
        {
          threadId: "external-thread",
          status: "stored",
          archived: false,
          createdActor: { type: "human" as const, id: "provider-spoof" },
          canContinue: true,
          canArchive: false,
        },
      ],
    };
    setSessionCatalogEntries([
      {
        sessionKey: "agent:main:owned",
        entry: { createdActor: { type: "agent", id: "worker-1" }, updatedAt: 1 },
      },
    ]);
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider("claude", {
          list: vi.fn(async ({ onHost }) => {
            onHost?.(host);
            return [host];
          }),
        }),
      },
    ];

    const respond = await call(
      "sessions.catalog.list",
      { progressId: "progress-creator" },
      {},
      { connId: "requester", connect: {} },
      { broadcastToConnIds },
    );
    const projectedSessions = [
      expect.objectContaining({
        threadId: "owned-thread",
        createdActor: {
          type: "agent",
          id: "worker-1",
          identity: { type: "agent", id: "worker-1" },
        },
      }),
      expect.not.objectContaining({ createdActor: expect.anything() }),
      expect.not.objectContaining({ createdActor: expect.anything() }),
    ];

    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.catalog.host",
      expect.objectContaining({
        catalog: expect.objectContaining({
          hosts: [expect.objectContaining({ sessions: projectedSessions })],
        }),
      }),
      new Set(["requester"]),
      { dropIfSlow: true },
    );
    expect(respond).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({
          hosts: [expect.objectContaining({ sessions: projectedSessions })],
        }),
      ],
    });
  });

  it("does not clone the shared list projection across catalog requests", async () => {
    const storedEntries = [
      {
        sessionKey: "agent:main:shared",
        entry: { createdActor: { type: "agent" as const, id: "worker" }, updatedAt: 1 },
      },
    ];
    setSessionCatalogEntries(storedEntries);
    const observedEntries: unknown[] = [];
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider("claude", {
          list: vi.fn(async ({ sessionEntries }) => {
            observedEntries.push(sessionEntries?.entriesForAgent("main"));
            return [];
          }),
        }),
      },
    ];
    const config = {};
    const context = createSessionCatalogTestContext(config);
    const cloneSpy = vi.spyOn(globalThis, "structuredClone");
    try {
      for (let pass = 0; pass < 2; pass++) {
        const respond = vi.fn();
        await sessionCatalogHandlers["sessions.catalog.list"]!({
          params: {},
          context,
          respond,
        } as never);
        expect(respond).toHaveBeenCalledWith(true, expect.anything());
      }

      expect(cloneSpy).not.toHaveBeenCalled();
      expect(observedEntries).toEqual([
        [
          expect.objectContaining({
            sessionKey: "agent:main:shared",
            entry: expect.objectContaining(storedEntries[0]!.entry),
          }),
        ],
        [
          expect.objectContaining({
            sessionKey: "agent:main:shared",
            entry: expect.objectContaining(storedEntries[0]!.entry),
          }),
        ],
      ]);
    } finally {
      cloneSpy.mockRestore();
    }
  });

  it("shares one lazy Gateway node snapshot across catalog providers", async () => {
    const dispatchNodeList = vi.fn(async () => ({
      nodes: [{ nodeId: "shared-node", connected: true }],
    }));
    bindPluginRegistryRuntime(
      hoisted.activeRegistry as PluginRegistry,
      createPluginRuntime({
        nodes: {
          list: dispatchNodeList,
          invoke: vi.fn(async () => undefined),
          openDuplex: vi.fn(),
        },
      }),
    );
    const catalogUsingNodes = (id: string) =>
      provider(id, {
        list: vi.fn(async ({ listNodes }) => {
          expect(await listNodes?.()).toEqual({
            nodes: [{ nodeId: "shared-node", connected: true }],
          });
          return [];
        }),
      });
    hoisted.activeRegistry!.sessionCatalogs = [
      { provider: catalogUsingNodes("zeta") },
      { provider: catalogUsingNodes("alpha") },
    ];

    await call("sessions.catalog.list", {});

    expect(dispatchNodeList).toHaveBeenCalledOnce();
  });

  it("rejects host cursors without a catalog selector", async () => {
    const respond = await call("sessions.catalog.list", {
      cursors: { "gateway:local": "next" },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: "catalogId is required when cursors are provided",
      }),
    );
  });

  it("advertises terminal opening only for providers that implement it", async () => {
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider("codex", {
          openTerminal: async () => ({ kind: "local", argv: ["codex", "resume", "thread"] }),
        }),
      },
      { provider: provider("readonly") },
    ];
    const respond = await call("sessions.catalog.list", {});
    expect(respond).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({ capabilities: expect.objectContaining({ openTerminal: true }) }),
        expect.objectContaining({ capabilities: { continueSession: false, archive: false } }),
      ],
    });
  });

  it("memoizes create targets until config changes", async () => {
    const metadataOnly = false;
    let createSession: { model: string; agentRuntime: string } | undefined = {
      model: "anthropic/claude-opus-4-8",
      agentRuntime: "claude-cli",
    };
    const resolveCreateSession = vi.fn(() => createSession);
    hoisted.activeRegistry.sessionCatalogs = [
      {
        pluginId: "anthropic",
        provider: provider("claude", {
          resolveCreateSession,
        }),
      },
    ];
    const config = {};

    const respond = await call("sessions.catalog.list", { metadataOnly }, config);

    expect(respond).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({
          id: "claude",
          capabilities: {
            continueSession: false,
            archive: false,
            createSession: { model: "anthropic/claude-opus-4-8" },
          },
        }),
      ],
    });

    createSession = undefined;
    const cached = await call("sessions.catalog.list", { metadataOnly }, config);
    expect(cached).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({
          capabilities: expect.objectContaining({
            createSession: { model: "anthropic/claude-opus-4-8" },
          }),
        }),
      ],
    });
    expect(resolveCreateSession).toHaveBeenCalledOnce();

    const refreshed = await call("sessions.catalog.list", { metadataOnly }, {});
    expect(refreshed).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({
          id: "claude",
          capabilities: {
            continueSession: false,
            archive: false,
          },
        }),
      ],
    });
    expect(resolveCreateSession).toHaveBeenCalledTimes(2);
  });

  it("retries an exception-derived create target failure without a config reload", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const resolveCreateSession = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("provider warming");
      })
      .mockReturnValue({
        model: "anthropic/claude-opus-4-8",
        agentRuntime: "claude-cli",
      });
    hoisted.activeRegistry.sessionCatalogs = [
      { provider: provider("claude", { resolveCreateSession }) },
    ];
    const config = {};

    try {
      const unavailable = await call("sessions.catalog.list", {}, config);
      expect(unavailable).toHaveBeenCalledWith(true, {
        catalogs: [
          expect.objectContaining({
            capabilities: { continueSession: false, archive: false },
          }),
        ],
      });
      now += 3_001;
      const recovered = await call("sessions.catalog.list", {}, config);
      expect(recovered).toHaveBeenCalledWith(true, {
        catalogs: [
          expect.objectContaining({
            capabilities: expect.objectContaining({
              createSession: { model: "anthropic/claude-opus-4-8" },
            }),
          }),
        ],
      });
      expect(resolveCreateSession).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("resolves creation capability for the requested agent", async () => {
    const metadataOnly = true;
    const resolveCreateSession = vi.fn(({ agentId }: { agentId?: string }) =>
      agentId === "research"
        ? { model: "anthropic/claude-opus-4-8", agentRuntime: "claude-cli" }
        : undefined,
    );
    hoisted.activeRegistry.sessionCatalogs = [
      {
        pluginId: "anthropic",
        provider: provider("claude", { resolveCreateSession }),
      },
    ];

    const available = await call(
      "sessions.catalog.list",
      {
        agentId: "research",
        catalogId: "claude",
        metadataOnly,
      },
      { agents: { entries: { main: {}, research: {} } } },
    );
    expect(resolveCreateSession).toHaveBeenCalledWith({ agentId: "research" });
    expect(available).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({
          capabilities: {
            continueSession: false,
            archive: false,
            createSession: { model: "anthropic/claude-opus-4-8" },
          },
        }),
      ],
    });
  });

  it("resolves the private runtime target separately from the public capability", () => {
    hoisted.activeRegistry.sessionCatalogs = [
      {
        pluginId: "anthropic",
        provider: provider("claude", {
          resolveCreateSession: () => ({
            model: "anthropic/claude-opus-4-8",
            agentRuntime: "claude-cli",
          }),
        }),
      },
    ];

    expect(resolveRegisteredCatalogCreateTarget("claude", "research", {})).toEqual({
      ok: true,
      target: {
        model: "anthropic/claude-opus-4-8",
        agentRuntime: "claude-cli",
        pluginOwnerId: "anthropic",
      },
    });
    expect(resolveRegisteredCatalogCreateTarget("missing", "research", {})).toEqual({
      ok: false,
      message: "unknown session catalog: missing",
      unknownCatalog: true,
    });
  });

  it("installs a provider-requested binding on the adopted Control UI session", async () => {
    const afterConversationBound = vi.fn(async () => undefined);
    const continueSession = vi.fn(async () => ({
      sessionKey: "agent:main:adopted",
      conversationBinding: {
        summary: "Continue remotely",
        data: { kind: "remote-runtime", version: 1 },
      },
      afterConversationBound,
    }));
    hoisted.activeRegistry.sessionCatalogs = [
      {
        pluginId: "remote",
        pluginName: "Remote Runtime",
        rootDir: "/plugins/remote",
        source: "/plugins/remote/index.ts",
        provider: provider("remote", { continueSession }),
      },
    ];

    const respond = await call(
      "sessions.catalog.continue",
      { catalogId: "remote", hostId: "node:devbox", threadId: "thread-1" },
      {},
      { connect: { scopes: ["operator.write", "operator.admin"] } },
    );

    expect(continueSession).toHaveBeenCalledWith({
      agentId: "main",
      allowProcessHomeFallback: false,
      hostId: "node:devbox",
      threadId: "thread-1",
      clientScopes: ["operator.write", "operator.admin"],
    });
    expect(conversationBindingMocks.bindPluginSessionConversation).toHaveBeenCalledWith({
      pluginId: "remote",
      pluginName: "Remote Runtime",
      pluginRoot: "/plugins/remote",
      sessionKey: "agent:main:adopted",
      binding: {
        summary: "Continue remotely",
        data: { kind: "remote-runtime", version: 1 },
      },
      afterBind: afterConversationBound,
    });
    expect(afterConversationBound).toHaveBeenCalledOnce();
    expect(
      conversationBindingMocks.bindPluginSessionConversation.mock.invocationCallOrder[0],
    ).toBeLessThan(afterConversationBound.mock.invocationCallOrder[0] ?? 0);
    expect(respond).toHaveBeenCalledWith(true, { sessionKey: "agent:main:adopted" });
  });
});

it("keeps a delayed source off the catalog RPC path", async () => {
  const sourceDelayMs = 5_000;
  resetSessionCatalogTestState();
  vi.useFakeTimers();
  const row = {
    threadId: "agent:main:shared",
    name: "Shared session",
    status: "idle",
    archived: false,
    canContinue: false,
    canArchive: false,
  };
  const source = createDeferredCore();
  const refresh = createDeferredCore();
  const invokeNode = vi.fn(async () => {
    await source.promise;
    return { sessions: [row] };
  });
  const config = {};
  const baselineStarted = Date.now();
  const baseline = startCall("sessions.catalog.list", {}, config);
  await baseline.completion;
  const baselineMs = Date.now() - baselineStarted;
  let connected = true;
  const runtime = createPluginRuntimeMock({
    config: { current: () => config },
    nodes: {
      list: async () => ({
        nodes: [
          {
            nodeId: "source",
            connected,
            commands: ["openclaw.sessions.list.v1", "openclaw.sessions.read.v1"],
          },
        ],
      }),
      invoke: async () => {
        throw new Error("must use service authority");
      },
    },
  });
  let service: Parameters<OpenClawPluginApi["registerService"]>[0] | undefined;
  const api = createTestPluginApi({
    runtime,
    registerService: (registered) => {
      service = registered;
    },
    registerSessionCatalog: (registeredCatalog) => {
      hoisted.activeRegistry.sessionCatalogs = [{ provider: registeredCatalog }];
    },
  });
  sessionSharePlugin.register(api);
  const scheduler = createTestPluginServiceScheduler();
  const context = { config, logger: api.logger, stateDir: "/unused", invokeNode, scheduler };
  await service?.start(context);
  bindPluginRegistryRuntime(hoisted.activeRegistry as PluginRegistry, runtime);
  hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(true);
  const clients = Array.from({ length: 6 }, (_, index) => ({
    connId: `viewer-${index}`,
    connect: { scopes: ["operator.admin"] },
  }));
  const broadcasts = clients.map(() => vi.fn());
  const elapsed: number[] = [];
  const started = Date.now();
  try {
    const calls = clients.map((client, index) =>
      startCall(
        "sessions.catalog.list",
        { catalogId: "openclaw", progressId: `progress-${index}`, allowPartialResults: true },
        config,
        client,
        { broadcastToConnIds: broadcasts[index] },
      ),
    );
    const done = Promise.all(
      calls.map(async (pendingCall) => {
        await pendingCall.completion;
        elapsed.push(Date.now() - started);
      }),
    );
    const metadata = startCall(
      "sessions.catalog.list",
      { catalogId: "openclaw", hostIds: ["node:source"] },
      config,
      clients[0],
    );
    await vi.advanceTimersByTimeAsync(49);
    expect(elapsed).toHaveLength(6);
    expect(Math.max(...elapsed)).toBe(baselineMs);
    expect(Math.max(...elapsed)).toBeLessThan(50);
    expect(invokeNode).toHaveBeenCalledTimes(1);
    for (const pendingCall of calls) {
      expect(pendingCall.respond).toHaveBeenCalledWith(true, {
        catalogs: [
          expect.objectContaining({
            hosts: [
              expect.objectContaining({
                hostId: "node:source",
                sessions: [],
                error: expect.objectContaining({ code: "CATALOG_LOADING" }),
              }),
            ],
          }),
        ],
      });
    }
    expect(metadata.respond).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({
          hosts: [
            expect.objectContaining({
              error: expect.objectContaining({ code: "CATALOG_LOADING" }),
            }),
          ],
        }),
      ],
    });
    clients[5]!.connect.scopes = ["operator.read"];
    await vi.advanceTimersByTimeAsync(sourceDelayMs - 49);
    source.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await done;
    await metadata.completion;
    for (const [index, broadcast] of broadcasts.entries()) {
      expect(broadcast).toHaveBeenLastCalledWith(
        "sessions.catalog.host",
        expect.objectContaining({
          catalog: expect.objectContaining({
            hosts: [
              expect.objectContaining({
                sessions: index === 5 ? [] : [expect.objectContaining(row)],
              }),
            ],
          }),
        }),
        new Set([clients[index]!.connId]),
        { dropIfSlow: true },
      );
    }
    for (let index = 0; index < 6; index++) {
      const warm = startCall(
        "sessions.catalog.list",
        { catalogId: "openclaw" },
        config,
        clients[0],
      );
      await warm.completion;
      expect(warm.respond).toHaveBeenCalledWith(true, {
        catalogs: [
          expect.objectContaining({
            hosts: [
              expect.objectContaining({
                sessions: [expect.objectContaining(row)],
              }),
            ],
          }),
        ],
      });
    }
    expect(invokeNode).toHaveBeenCalledTimes(1);
    console.log(
      JSON.stringify({
        clock: "fake",
        baselineMs,
        sourceDelayMs,
        gatewayP99Ms: Math.max(...elapsed),
        invocations: invokeNode.mock.calls.length,
      }),
    );
    const progressiveQuery = {
      catalogId: "openclaw",
      progressId: "progress-0",
      allowPartialResults: true,
    };
    const current = startCall("sessions.catalog.list", progressiveQuery, config, clients[0], {
      broadcastToConnIds: broadcasts[0],
    });
    await current.completion;
    expect(current.respond.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toEqual([row]);
    invokeNode
      .mockRejectedValueOnce(new Error("Paired node did not respond"))
      .mockImplementation(async () => {
        await refresh.promise;
        throw new Error("Paired node did not respond");
      });
    await vi.advanceTimersByTimeAsync(60_005);
    expect(invokeNode).toHaveBeenCalledTimes(3);
    const refreshing = startCall("sessions.catalog.list", progressiveQuery, config, clients[0], {
      broadcastToConnIds: broadcasts[0],
    });
    await refreshing.completion;
    expect(refreshing.respond.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]).toMatchObject({
      sessions: [],
      error: { code: "NODE_INVOKE_FAILED" },
    });
    expect(refreshing.respond.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]).not.toHaveProperty(
      "pending",
    );
    refresh.resolve();
    await vi.advanceTimersByTimeAsync(0);
    for (const errorCode of ["NODE_INVOKE_FAILED", "NODE_OFFLINE"]) {
      connected = errorCode !== "NODE_OFFLINE";
      const expired = startCall(
        "sessions.catalog.list",
        { catalogId: "openclaw" },
        config,
        clients[0],
      );
      await expired.completion;
      expect(expired.respond).toHaveBeenCalledWith(true, {
        catalogs: [
          expect.objectContaining({
            hosts: [
              expect.objectContaining({
                sessions: [],
                error: expect.objectContaining({ code: errorCode }),
              }),
            ],
          }),
        ],
      });
    }
  } finally {
    scheduler.beginClose();
    source.resolve();
    refresh.resolve();
    try {
      await service?.stop?.(context);
    } finally {
      await scheduler.stop();
    }
    vi.useRealTimers();
  }
});
