import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PluginRegistry } from "../plugins/registry.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { PluginDiagnostic } from "../plugins/types.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";

const loadOpenClawPlugins = vi.hoisted(() => vi.fn());
type HandleGatewayRequestOptions = GatewayRequestOptions & {
  extraHandlers?: Record<string, unknown>;
};
const handleGatewayRequest = vi.hoisted(() =>
  vi.fn(async (_opts: HandleGatewayRequestOptions) => {}),
);

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins,
}));

vi.mock("./server-methods.js", () => ({
  handleGatewayRequest,
}));

const createRegistry = (diagnostics: PluginDiagnostic[]): PluginRegistry => ({
  plugins: [],
  tools: [],
  hooks: [],
  typedHooks: [],
  channels: [],
  commands: [],
  providers: [],
  gatewayHandlers: {},
  httpRoutes: [],
  cliRegistrars: [],
  services: [],
  diagnostics,
});

type ServerPluginsModule = typeof import("./server-plugins.js");

function createTestContext(label: string): GatewayRequestContext {
  return { label } as unknown as GatewayRequestContext;
}

function getLastDispatchedContext(): GatewayRequestContext | undefined {
  const call = handleGatewayRequest.mock.calls.at(-1)?.[0];
  return call?.context;
}

async function importServerPluginsModule(): Promise<ServerPluginsModule> {
  return import("./server-plugins.js");
}

function createSubagentRuntime(serverPlugins: ServerPluginsModule): PluginRuntime["subagent"] {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  loadOpenClawPlugins.mockReturnValue(createRegistry([]));
  serverPlugins.loadGatewayPlugins({
    cfg: {},
    workspaceDir: "/tmp",
    log,
    coreGatewayHandlers: {},
    baseMethods: [],
  });
  const call = loadOpenClawPlugins.mock.calls.at(-1)?.[0] as
    | { runtimeOptions?: { subagent?: PluginRuntime["subagent"] } }
    | undefined;
  if (!call?.runtimeOptions?.subagent) {
    throw new Error("Expected loadGatewayPlugins to provide subagent runtime");
  }
  return call.runtimeOptions.subagent;
}

beforeEach(() => {
  loadOpenClawPlugins.mockReset();
  handleGatewayRequest.mockReset();
  handleGatewayRequest.mockImplementation(async (opts: HandleGatewayRequestOptions) => {
    switch (opts.req.method) {
      case "agent":
        opts.respond(true, { runId: "run-1" });
        return;
      case "agent.wait":
        opts.respond(true, { status: "ok" });
        return;
      case "sessions.get":
        opts.respond(true, { messages: [] });
        return;
      case "sessions.delete":
        opts.respond(true, {});
        return;
      default:
        opts.respond(true, {});
    }
  });
});

afterEach(() => {
  vi.resetModules();
});

describe("loadGatewayPlugins", () => {
  test("invokeAgent uses deterministic session key and extracts text blocks", async () => {
    const serverPlugins = await importServerPluginsModule();
    const runtime = createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("invoke-agent"));

    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      if (opts.req.method === "agent") {
        opts.respond(true, { runId: "run-1" });
        return;
      }
      opts.respond(true, {});
    });
    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      if (opts.req.method === "agent.wait") {
        opts.respond(true, { status: "ok" });
        return;
      }
      opts.respond(true, {});
    });
    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      if (opts.req.method === "sessions.get") {
        opts.respond(true, {
          messages: [
            {
              role: "assistant",
              content: [
                { type: "text", text: "Hello" },
                { type: "tool_use", name: "noop" },
                { type: "text", text: "world" },
              ],
            },
          ],
        });
        return;
      }
      opts.respond(true, {});
    });

    const result = await runtime.invokeAgent?.({
      agentId: "kiki",
      messages: [{ role: "user", content: "say hi" }],
      idempotencyKey: "idem-123",
    });

    expect(result?.success).toBe(true);
    expect(result?.content).toBe("Hello\nworld");
    expect(result?.replyTag).toEqual({ hasReplyTag: false, replyToCurrent: false });
    expect(result?.sessionKey).toBe("agent:kiki:plugin-invoke:idem-123");

    const agentCall = handleGatewayRequest.mock.calls[0]?.[0] as
      | { req?: { params?: { sessionKey?: string } } }
      | undefined;
    const agentParams = agentCall?.req?.params;
    expect(agentParams?.sessionKey).toBe("agent:kiki:plugin-invoke:idem-123");
  });

  test("invokeAgent strips reply tags and returns reply-tag metadata", async () => {
    const serverPlugins = await importServerPluginsModule();
    const runtime = createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("invoke-agent-reply-tag"));

    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      if (opts.req.method === "agent") {
        opts.respond(true, { runId: "run-1" });
        return;
      }
      opts.respond(true, {});
    });
    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      if (opts.req.method === "agent.wait") {
        opts.respond(true, { status: "ok" });
        return;
      }
      opts.respond(true, {});
    });
    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      if (opts.req.method === "sessions.get") {
        opts.respond(true, {
          messages: [
            {
              role: "assistant",
              content: "On it [[reply_to:msg-42]]",
            },
          ],
        });
        return;
      }
      opts.respond(true, {});
    });

    const result = await runtime.invokeAgent?.({
      agentId: "kiki",
      prompt: "say yes",
      idempotencyKey: "idem-rt",
    });

    expect(result?.success).toBe(true);
    expect(result?.content).toBe("On it");
    expect(result?.replyTag).toEqual({
      hasReplyTag: true,
      replyToId: "msg-42",
      replyToCurrent: false,
    });
  });

  test("invokeAgentStream emits content deltas from assistant text", async () => {
    const serverPlugins = await importServerPluginsModule();
    const runtime = createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("invoke-agent-stream"));

    let sessionsGetCount = 0;
    handleGatewayRequest.mockImplementation(async (opts: HandleGatewayRequestOptions) => {
      if (opts.req.method === "agent") {
        opts.respond(true, { runId: "run-stream" });
        return;
      }
      if (opts.req.method === "sessions.get") {
        sessionsGetCount += 1;
        if (sessionsGetCount === 1) {
          opts.respond(true, {
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "hello" }],
              },
            ],
          });
          return;
        }
        opts.respond(true, {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "hello" }],
            },
          ],
        });
        return;
      }
      opts.respond(true, { status: "ok" });
    });

    const stream = await runtime.invokeAgentStream?.({
      agentId: "kiki",
      messages: [{ role: "user", content: "say hello" }],
      idempotencyKey: "idem-stream",
      timeoutSeconds: 3,
    });
    const reader = stream?.getReader();
    expect(reader).toBeTruthy();
    const decoder = new TextDecoder();
    let output = "";
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        output += decoder.decode(value, { stream: true });
      }
    }

    expect(output).toContain('"content":"hello"');
    expect(output).toContain('"finish_reason":"stop"');
  });

  test("logs plugin errors with details", async () => {
    const { loadGatewayPlugins } = await importServerPluginsModule();
    const diagnostics: PluginDiagnostic[] = [
      {
        level: "error",
        pluginId: "telegram",
        source: "/tmp/telegram/index.ts",
        message: "failed to load plugin: boom",
      },
    ];
    loadOpenClawPlugins.mockReturnValue(createRegistry(diagnostics));

    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    loadGatewayPlugins({
      cfg: {},
      workspaceDir: "/tmp",
      log,
      coreGatewayHandlers: {},
      baseMethods: [],
    });

    expect(log.error).toHaveBeenCalledWith(
      "[plugins] failed to load plugin: boom (plugin=telegram, source=/tmp/telegram/index.ts)",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("provides subagent runtime with sessions.get method aliases", async () => {
    const { loadGatewayPlugins } = await importServerPluginsModule();
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));

    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    loadGatewayPlugins({
      cfg: {},
      workspaceDir: "/tmp",
      log,
      coreGatewayHandlers: {},
      baseMethods: [],
    });

    const call = loadOpenClawPlugins.mock.calls.at(-1)?.[0];
    const subagent = call?.runtimeOptions?.subagent;
    expect(typeof subagent?.getSessionMessages).toBe("function");
    expect(typeof subagent?.getSession).toBe("function");
  });

  test("shares fallback context across module reloads for existing runtimes", async () => {
    const first = await importServerPluginsModule();
    const runtime = createSubagentRuntime(first);

    const staleContext = createTestContext("stale");
    first.setFallbackGatewayContext(staleContext);
    await runtime.run({ sessionKey: "s-1", message: "hello" });
    expect(getLastDispatchedContext()).toBe(staleContext);

    vi.resetModules();
    const reloaded = await importServerPluginsModule();
    const freshContext = createTestContext("fresh");
    reloaded.setFallbackGatewayContext(freshContext);

    await runtime.run({ sessionKey: "s-1", message: "hello again" });
    expect(getLastDispatchedContext()).toBe(freshContext);
  });

  test("uses updated fallback context after context replacement", async () => {
    const serverPlugins = await importServerPluginsModule();
    const runtime = createSubagentRuntime(serverPlugins);
    const firstContext = createTestContext("before-restart");
    const secondContext = createTestContext("after-restart");

    serverPlugins.setFallbackGatewayContext(firstContext);
    await runtime.run({ sessionKey: "s-2", message: "before restart" });
    expect(getLastDispatchedContext()).toBe(firstContext);

    serverPlugins.setFallbackGatewayContext(secondContext);
    await runtime.run({ sessionKey: "s-2", message: "after restart" });
    expect(getLastDispatchedContext()).toBe(secondContext);
  });

  test("reflects fallback context object mutation at dispatch time", async () => {
    const serverPlugins = await importServerPluginsModule();
    const runtime = createSubagentRuntime(serverPlugins);
    const context = { marker: "before-mutation" } as GatewayRequestContext & {
      marker: string;
    };

    serverPlugins.setFallbackGatewayContext(context);
    context.marker = "after-mutation";

    await runtime.run({ sessionKey: "s-3", message: "mutated context" });
    const dispatched = getLastDispatchedContext() as
      | (GatewayRequestContext & { marker: string })
      | undefined;
    expect(dispatched?.marker).toBe("after-mutation");
  });
});
