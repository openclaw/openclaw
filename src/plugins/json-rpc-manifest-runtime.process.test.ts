import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool, OpenClawPluginApi } from "./types.js";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  killProcessTree: vi.fn(),
  signalProcessTree: vi.fn(),
  resolveWindowsSpawnProgram: vi.fn(),
  materializeWindowsSpawnProgram: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
}));

vi.mock("../process/kill-tree.js", () => ({
  killProcessTree: mocks.killProcessTree,
  signalProcessTree: mocks.signalProcessTree,
}));

vi.mock("../plugin-sdk/windows-spawn.js", () => ({
  resolveWindowsSpawnProgram: mocks.resolveWindowsSpawnProgram,
  materializeWindowsSpawnProgram: mocks.materializeWindowsSpawnProgram,
}));

import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import { createJsonRpcManifestPluginDefinition } from "./json-rpc-manifest-runtime.js";

describe("createJsonRpcManifestPluginDefinition process management", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("resolves child commands through the Windows spawn resolver", async () => {
    const program = {
      command: "resolved-node",
      leadingArgv: ["entry.mjs"],
      resolution: "node-entrypoint",
      windowsHide: true,
    };
    mocks.resolveWindowsSpawnProgram.mockReturnValue(program);
    mocks.materializeWindowsSpawnProgram.mockReturnValue({
      command: "resolved-node",
      argv: ["entry.mjs", "--stdio"],
      shell: false,
      windowsHide: true,
    });
    mocks.spawn.mockReturnValue(asSpawnedChild(new FakeJsonRpcChild()));

    const tools: AnyAgentTool[] = [];
    const api = createProcessTestApi({
      registerTool(tool) {
        if (typeof tool !== "function") {
          tools.push(tool);
        }
      },
    });
    const entry = createJsonRpcManifestPluginDefinition({
      protocolVersion: 1,
      id: "json-rpc-process-test",
      name: "JSON RPC Process Test",
      description: "Test spawn resolution",
      process: {
        command: "json-rpc-child",
        args: ["--stdio"],
        env: { JSON_RPC_PROCESS_TEST: "1" },
      },
      registrations: [
        {
          type: "tool",
          name: "json_rpc_process",
          description: "Process",
        },
      ],
    });

    entry.register?.(api);
    await tools[0]?.execute("tool-call-1", {});

    expect(mocks.resolveWindowsSpawnProgram).toHaveBeenCalledWith({
      command: "json-rpc-child",
      platform: process.platform,
      env: expect.objectContaining({ JSON_RPC_PROCESS_TEST: "1" }),
      execPath: process.execPath,
      allowShellFallback: false,
    });
    expect(mocks.materializeWindowsSpawnProgram).toHaveBeenCalledWith(program, ["--stdio"]);
    expect(mocks.spawn).toHaveBeenCalledWith(
      "resolved-node",
      ["entry.mjs", "--stdio"],
      expect.objectContaining({
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }),
    );
  });

  it("does not start a child process for a pre-aborted request", async () => {
    const tools: AnyAgentTool[] = [];
    const api = createProcessTestApi({
      registerTool(tool) {
        if (typeof tool !== "function") {
          tools.push(tool);
        }
      },
    });
    const entry = createJsonRpcManifestPluginDefinition({
      protocolVersion: 1,
      id: "json-rpc-process-abort-test",
      name: "JSON RPC Process Abort Test",
      description: "Test pre-aborted process requests",
      process: {
        command: "json-rpc-child",
      },
      registrations: [
        {
          type: "tool",
          name: "json_rpc_process_abort",
          description: "Process abort",
        },
      ],
    });
    const controller = new AbortController();
    controller.abort();

    entry.register?.(api);
    await expect(tools[0]?.execute("tool-call-abort", {}, controller.signal)).rejects.toThrow(
      "JSON-RPC plugin request aborted",
    );

    expect(mocks.resolveWindowsSpawnProgram).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("materializes callbacks only at audited generic registration paths", () => {
    let service: Parameters<OpenClawPluginApi["registerService"]>[0] | undefined;
    let subscription:
      | Parameters<OpenClawPluginApi["registerAgentEventSubscription"]>[0]
      | undefined;
    const api = createProcessTestApi({
      registerService(registration) {
        service = registration;
      },
      registerAgentEventSubscription(registration) {
        subscription = registration;
      },
    });
    const entry = createJsonRpcManifestPluginDefinition({
      protocolVersion: 1,
      id: "json-rpc-generic-registration-test",
      name: "JSON RPC Generic Registration Test",
      description: "Generic registration test",
      process: { command: "json-rpc-child" },
      registrations: [
        {
          type: "api",
          method: "registerService",
          args: [
            {
              id: "remote-service",
              start: { $rpc: "service.start" },
              stop: { $rpc: "service.stop" },
            },
          ],
        },
        {
          type: "api",
          method: "registerAgentEventSubscription",
          args: [
            {
              id: "remote-events",
              streams: ["run"],
              handle: { $rpc: "events.handle" },
            },
          ],
        },
      ],
    });

    entry.register?.(api);

    expect(service?.start).toBeTypeOf("function");
    expect(service?.stop).toBeTypeOf("function");
    expect(subscription?.handle).toBeTypeOf("function");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("registers process disposal after remote lifecycle cleanup", () => {
    const lifecycleIds: string[] = [];
    const registerRuntimeLifecycle: OpenClawPluginApi["registerRuntimeLifecycle"] = (lifecycle) => {
      lifecycleIds.push(lifecycle.id);
    };
    const api = createProcessTestApi({
      registerRuntimeLifecycle,
      lifecycle: { registerRuntimeLifecycle } as OpenClawPluginApi["lifecycle"],
    });
    const entry = createJsonRpcManifestPluginDefinition({
      protocolVersion: 1,
      id: "json-rpc-lifecycle-order-test",
      name: "JSON RPC Lifecycle Order Test",
      description: "Lifecycle order test",
      process: { command: "json-rpc-child" },
      registrations: [
        {
          type: "api",
          method: "registerRuntimeLifecycle",
          args: [{ id: "remote-cleanup", cleanup: { $rpc: "lifecycle.cleanup" } }],
        },
      ],
    });

    entry.register?.(api);

    expect(lifecycleIds).toEqual([
      "remote-cleanup",
      "json-rpc-lifecycle-order-test.json-rpc-process",
    ]);
  });

  it("rejects generic registrations with synchronous or unaudited callback paths", () => {
    const api = createProcessTestApi();
    const syncProvider = createJsonRpcManifestPluginDefinition({
      protocolVersion: 1,
      id: "json-rpc-sync-provider-test",
      name: "JSON RPC Sync Provider Test",
      description: "Sync provider test",
      process: { command: "json-rpc-child" },
      registrations: [
        {
          type: "api",
          method: "registerSpeechProvider",
          args: [{ id: "remote-speech", isConfigured: { $rpc: "speech.isConfigured" } }],
        },
      ],
    });
    expect(() => syncProvider.register?.(api)).toThrow(
      "unsupported JSON-RPC plugin registration method: registerSpeechProvider",
    );

    const wrongPath = createJsonRpcManifestPluginDefinition({
      protocolVersion: 1,
      id: "json-rpc-callback-path-test",
      name: "JSON RPC Callback Path Test",
      description: "Callback path test",
      process: { command: "json-rpc-child" },
      registrations: [
        {
          type: "api",
          method: "registerService",
          args: [{ id: "remote-service", unexpected: { $rpc: "service.unexpected" } }],
        },
      ],
    });
    expect(() => wrongPath.register?.(api)).toThrow(
      "JSON-RPC callback is not supported at registration argument path: 0.unexpected",
    );

    const wireMarker = createJsonRpcManifestPluginDefinition({
      protocolVersion: 1,
      id: "json-rpc-wire-marker-test",
      name: "JSON RPC Wire Marker Test",
      description: "Wire marker test",
      process: { command: "json-rpc-child" },
      registrations: [
        {
          type: "api",
          method: "registerSessionExtension",
          args: [{ id: "remote-state", project: { $callback: "smuggled" } }],
        },
      ],
    });
    expect(() => wireMarker.register?.(api)).toThrow(
      "JSON-RPC wire marker is not allowed in registration arguments: $callback",
    );
  });

  it("rejects unsupported protocol versions and synchronous hooks", () => {
    const api = createProcessTestApi();
    const unsupported = createJsonRpcManifestPluginDefinition({
      protocolVersion: 2 as never,
      id: "json-rpc-version-test",
      name: "JSON RPC Version Test",
      description: "Version test",
      process: { command: "json-rpc-child" },
      registrations: [{ type: "tool", name: "version", description: "Version" }],
    });
    expect(() => unsupported.register?.(api)).toThrow(
      "unsupported JSON-RPC plugin protocol version",
    );

    const syncHook = createJsonRpcManifestPluginDefinition({
      protocolVersion: 1,
      id: "json-rpc-sync-hook-test",
      name: "JSON RPC Sync Hook Test",
      description: "Sync hook test",
      process: { command: "json-rpc-child" },
      registrations: [{ type: "hook", hook: "before_message_write" }],
    });
    expect(() => syncHook.register?.(api)).toThrow(
      "JSON-RPC plugins cannot register synchronous hook",
    );
  });

  it("honors aborts while initialization is pending without canceling shared initialization", async () => {
    mocks.resolveWindowsSpawnProgram.mockReturnValue({
      command: "json-rpc-child",
      leadingArgv: [],
      resolution: "direct",
      windowsHide: true,
    });
    mocks.materializeWindowsSpawnProgram.mockReturnValue({
      command: "json-rpc-child",
      argv: [],
      shell: false,
      windowsHide: true,
    });
    const child = new FakeJsonRpcChild({ deferInitialize: true });
    mocks.spawn.mockReturnValue(asSpawnedChild(child));

    const tools: AnyAgentTool[] = [];
    const api = createProcessTestApi({
      registerTool(tool) {
        if (typeof tool !== "function") {
          tools.push(tool);
        }
      },
    });
    const entry = createJsonRpcManifestPluginDefinition({
      protocolVersion: 1,
      id: "json-rpc-process-init-abort-test",
      name: "JSON RPC Process Init Abort Test",
      description: "Test initialization abort",
      process: {
        command: "json-rpc-child",
      },
      registrations: [
        {
          type: "tool",
          name: "json_rpc_process_init_abort",
          description: "Process init abort",
        },
      ],
    });
    const controller = new AbortController();

    entry.register?.(api);
    const aborted = tools[0]?.execute("tool-call-abort", {}, controller.signal);
    controller.abort();

    await expect(observeSettled(aborted)).resolves.toBe("JSON-RPC plugin request aborted");

    const active = tools[0]?.execute("tool-call-active", {});
    child.resolveInitialize();
    await expect(active).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  it("stops a child before buffering an oversized unterminated frame", async () => {
    mocks.resolveWindowsSpawnProgram.mockReturnValue({
      command: "json-rpc-child",
      leadingArgv: [],
      resolution: "direct",
      windowsHide: true,
    });
    mocks.materializeWindowsSpawnProgram.mockReturnValue({
      command: "json-rpc-child",
      argv: [],
      shell: false,
      windowsHide: true,
    });
    const child = new FakeJsonRpcChild({ deferInitialize: true });
    mocks.spawn.mockReturnValue(asSpawnedChild(child));
    const tools: AnyAgentTool[] = [];
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const api = createProcessTestApi({
      logger,
      registerTool(tool) {
        if (typeof tool !== "function") {
          tools.push(tool);
        }
      },
    });
    const entry = createJsonRpcManifestPluginDefinition({
      protocolVersion: 1,
      id: "json-rpc-frame-limit-test",
      name: "JSON RPC Frame Limit Test",
      description: "Frame limit test",
      process: { command: "json-rpc-child", maxFrameBytes: 16 },
      registrations: [{ type: "tool", name: "frame_limit", description: "Frame limit" }],
    });

    entry.register?.(api);
    const pending = tools[0]?.execute("tool-call", {});
    child.stdout.write(Buffer.alloc(17, 0x78));

    await expect(pending).rejects.toThrow("JSON-RPC plugin process was disposed");
    expect(logger.warn).toHaveBeenCalledWith(
      "JSON-RPC plugin json-rpc-process-test exceeded the frame size limit",
    );
  });

  it("uses process-tree cleanup when stdin shutdown does not stop the child", async () => {
    vi.useFakeTimers();
    mocks.resolveWindowsSpawnProgram.mockReturnValue({
      command: "json-rpc-child",
      leadingArgv: [],
      resolution: "direct",
      windowsHide: true,
    });
    mocks.materializeWindowsSpawnProgram.mockReturnValue({
      command: "json-rpc-child",
      argv: [],
      shell: false,
      windowsHide: true,
    });
    mocks.spawn.mockReturnValue(asSpawnedChild(new FakeJsonRpcChild({ closeOnStdinEnd: false })));

    const tools: AnyAgentTool[] = [];
    let cleanup:
      | NonNullable<Parameters<OpenClawPluginApi["registerRuntimeLifecycle"]>[0]["cleanup"]>
      | undefined;
    const api = createProcessTestApi({
      registerTool(tool) {
        if (typeof tool !== "function") {
          tools.push(tool);
        }
      },
      registerRuntimeLifecycle(lifecycle) {
        cleanup = lifecycle.cleanup;
      },
    });
    const entry = createJsonRpcManifestPluginDefinition({
      protocolVersion: 1,
      id: "json-rpc-process-cleanup-test",
      name: "JSON RPC Process Cleanup Test",
      description: "Test process-tree cleanup",
      process: {
        command: "json-rpc-child",
      },
      registrations: [
        {
          type: "tool",
          name: "json_rpc_process_cleanup",
          description: "Process cleanup",
        },
      ],
    });

    entry.register?.(api);
    await tools[0]?.execute("tool-call-1", {});

    const cleanupPromise = cleanup?.({ reason: "restart" });
    await vi.advanceTimersByTimeAsync(5_000);
    await cleanupPromise;

    expect(mocks.killProcessTree).toHaveBeenCalledWith(4321, { graceMs: 500 });
    expect(mocks.signalProcessTree).toHaveBeenCalledWith(4321, "SIGKILL");
  });
});

function createProcessTestApi(overrides: Partial<OpenClawPluginApi> = {}): OpenClawPluginApi {
  return createTestPluginApi({
    id: "json-rpc-process-test",
    name: "JSON RPC Process Test",
    source: "src/plugins/json-rpc-manifest-runtime.process.test.ts",
    rootDir: process.cwd(),
    ...overrides,
  });
}

class FakeJsonRpcChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4321;
  readonly kill = vi.fn();
  readonly stdin: Writable;
  private deferredInitialize: (() => void) | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(options: { closeOnStdinEnd?: boolean; deferInitialize?: boolean } = {}) {
    super();
    const closeOnStdinEnd = options.closeOnStdinEnd ?? true;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.writeResponse(String(chunk), options.deferInitialize === true);
        callback();
      },
      final: (callback) => {
        if (closeOnStdinEnd) {
          this.exitCode = 0;
          this.emit("close", 0, null);
        }
        callback();
      },
    });
  }

  resolveInitialize(): void {
    this.deferredInitialize?.();
    this.deferredInitialize = undefined;
  }

  private writeResponse(chunk: string, deferInitialize: boolean): void {
    for (const line of chunk.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      const message = JSON.parse(line) as { id: unknown; method: string };
      if (message.method === "openclaw.initialize" && deferInitialize) {
        this.deferredInitialize = () =>
          this.writeJsonRpcResult(message.id, { ok: true, protocolVersion: 1 });
        continue;
      }
      const result =
        message.method === "openclaw.tool.execute"
          ? { content: [{ type: "text", text: "ok" }] }
          : { ok: true, protocolVersion: 1 };
      this.writeJsonRpcResult(message.id, result);
    }
  }

  private writeJsonRpcResult(id: unknown, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }
}

function asSpawnedChild(child: FakeJsonRpcChild): ChildProcessWithoutNullStreams {
  return child as unknown as ChildProcessWithoutNullStreams;
}

function observeSettled(promise: Promise<unknown> | undefined): Promise<string> {
  if (!promise) {
    return Promise.resolve("missing");
  }
  return Promise.race([
    promise.then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    ),
    new Promise<string>((resolve) => {
      setTimeout(() => resolve("pending"), 25);
    }),
  ]);
}
