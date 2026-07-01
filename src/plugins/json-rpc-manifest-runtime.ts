// JSON-RPC manifest entries bridge static plugin descriptors to child-process runtimes.
import { Buffer } from "node:buffer";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { IncomingMessage } from "node:http";
import type { ServerResponse } from "node:http";
import path from "node:path";
import type { Readable } from "node:stream";
import type { ErrorShape } from "../../packages/gateway-protocol/src/index.js";
import type { RespondFn } from "../gateway/server-methods/types.js";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "../plugin-sdk/windows-spawn.js";
import { killProcessTree, signalProcessTree } from "../process/kill-tree.js";
import { isPluginHookName, type PluginHookHandlerMap } from "./hook-types.js";
import { JsonRpcPeer } from "./json-rpc-peer.js";
import {
  JSON_RPC_PLUGIN_PROTOCOL_VERSION,
  JsonRpcPluginProtocol,
} from "./json-rpc-plugin-protocol.js";
import type { PluginManifestJsonRpc, PluginManifestJsonRpcRegistration } from "./manifest.js";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginConfigSchema,
  OpenClawPluginDefinition,
} from "./types.js";

export type JsonRpcPluginJsonPrimitive = string | number | boolean | null;
export type JsonRpcPluginJsonValue =
  | JsonRpcPluginJsonPrimitive
  | { [key: string]: JsonRpcPluginJsonValue }
  | JsonRpcPluginJsonValue[];
export type JsonRpcPluginJsonObject = { [key: string]: JsonRpcPluginJsonValue };

export type JsonRpcPluginProcessOptions = PluginManifestJsonRpc["process"];

export type JsonRpcPluginRegistration = PluginManifestJsonRpcRegistration;
export type JsonRpcPluginToolRegistration = Extract<JsonRpcPluginRegistration, { type: "tool" }>;
export type JsonRpcPluginHookRegistration = Extract<JsonRpcPluginRegistration, { type: "hook" }>;
export type JsonRpcPluginHttpRouteRegistration = Extract<
  JsonRpcPluginRegistration,
  { type: "httpRoute" }
>;
export type JsonRpcPluginGatewayMethodRegistration = Extract<
  JsonRpcPluginRegistration,
  { type: "gatewayMethod" }
>;
export type JsonRpcPluginApiRegistration = Extract<JsonRpcPluginRegistration, { type: "api" }>;

export type JsonRpcManifestPluginOptions = {
  id: string;
  name: string;
  description: string;
  kind?: OpenClawPluginDefinition["kind"];
  configSchema?: OpenClawPluginConfigSchema;
  protocolVersion: PluginManifestJsonRpc["protocolVersion"];
  process: JsonRpcPluginProcessOptions;
  permissions?: PluginManifestJsonRpc["permissions"];
  registrations: readonly JsonRpcPluginRegistration[];
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_PENDING_REQUESTS = 256;
const DEFAULT_HTTP_BODY_LIMIT_BYTES = 1024 * 1024;
const PROCESS_CLOSE_TIMEOUT_MS = 2_000;
const PROCESS_TREE_KILL_GRACE_MS = 500;
const SIGKILL_REAP_TIMEOUT_MS = 500;
const DEFAULT_TOOL_METHOD = "openclaw.tool.execute";
const DEFAULT_HOOK_METHOD = "openclaw.hook.handle";
const DEFAULT_HTTP_METHOD = "openclaw.http.handle";
const DEFAULT_GATEWAY_METHOD = "openclaw.gateway.handle";
const EMPTY_OBJECT_SCHEMA = {
  type: "object",
  additionalProperties: false,
} as const satisfies JsonRpcPluginJsonObject;
const JSON_RPC_API_CALLBACK_PATHS = new Map<keyof OpenClawPluginApi, ReadonlySet<string>>([
  ["registerAgentEventSubscription", new Set(["0.handle"])],
  ["registerAgentToolResultMiddleware", new Set(["0"])],
  ["registerCommand", new Set(["0.handler"])],
  ["registerCompactionProvider", new Set(["0.summarize"])],
  ["registerControlUiDescriptor", new Set()],
  ["registerGatewayDiscoveryService", new Set(["0.advertise"])],
  ["registerHostedMediaResolver", new Set(["0"])],
  ["registerInteractiveHandler", new Set(["0.handler"])],
  ["registerNodeHostCommand", new Set(["0.handle"])],
  ["registerNodeInvokePolicy", new Set(["0.handle"])],
  ["registerReload", new Set()],
  ["registerRuntimeLifecycle", new Set(["0.cleanup"])],
  ["registerService", new Set(["0.start", "0.stop"])],
  ["registerSessionAction", new Set(["0.handler"])],
  ["registerSessionExtension", new Set()],
  ["registerSessionSchedulerJob", new Set()],
  ["registerTool", new Set(["0.execute"])],
  ["registerToolMetadata", new Set()],
  ["onConversationBindingResolved", new Set(["0"])],
]);

export function createJsonRpcManifestPluginDefinition(
  options: JsonRpcManifestPluginOptions,
): OpenClawPluginDefinition {
  return {
    id: options.id,
    name: options.name,
    description: options.description,
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.configSchema ? { configSchema: options.configSchema } : {}),
    register(api) {
      if (options.protocolVersion !== JSON_RPC_PLUGIN_PROTOCOL_VERSION) {
        throw new Error("unsupported JSON-RPC plugin protocol version");
      }
      const client = new JsonRpcPluginClient(api, options);
      const gatewayStopHooks = options.registrations.filter(isGatewayStopHookRegistration);
      for (const registration of options.registrations) {
        if (isGatewayStopHookRegistration(registration)) {
          continue;
        }
        registerJsonRpcSurface(api, client, registration);
      }
      registerJsonRpcGatewayStopHook(api, client, gatewayStopHooks);
      // Remote cleanup must run before the transport that carries it is terminated.
      api.lifecycle.registerRuntimeLifecycle({
        id: `${options.id}.json-rpc-process`,
        description: "JSON-RPC child process owned by this plugin",
        cleanup: async ({ reason }) => {
          if (reason === "disable" || reason === "restart") {
            await client.dispose();
          }
        },
      });
    },
  };
}

function registerJsonRpcSurface(
  api: OpenClawPluginApi,
  client: JsonRpcPluginClient,
  registration: JsonRpcPluginRegistration,
): void {
  if (registration.type === "tool") {
    registerJsonRpcTool(api, client, registration);
    return;
  }
  if (registration.type === "hook") {
    registerJsonRpcHook(api, client, registration);
    return;
  }
  if (registration.type === "httpRoute") {
    registerJsonRpcHttpRoute(api, client, registration);
    return;
  }
  if (registration.type === "gatewayMethod") {
    registerJsonRpcGatewayMethod(api, client, registration);
    return;
  }
  registerJsonRpcApi(api, client, registration);
}

function registerJsonRpcApi(
  api: OpenClawPluginApi,
  client: JsonRpcPluginClient,
  registration: JsonRpcPluginApiRegistration,
): void {
  const methodName = registration.method as keyof OpenClawPluginApi;
  const callbackPaths = JSON_RPC_API_CALLBACK_PATHS.get(methodName);
  if (!callbackPaths) {
    throw new Error(`unsupported JSON-RPC plugin registration method: ${registration.method}`);
  }
  validateJsonRpcCallbackPaths(registration.args, callbackPaths);
  const method = api[methodName];
  if (typeof method !== "function") {
    throw new Error(`unknown JSON-RPC plugin registration method: ${registration.method}`);
  }
  Reflect.apply(
    method,
    api,
    registration.args.map((arg) => client.materialize(arg)),
  );
}

function validateJsonRpcCallbackPaths(value: unknown, allowed: ReadonlySet<string>): void {
  const visit = (current: unknown, valuePath: string): void => {
    if (Array.isArray(current)) {
      current.forEach((entry, index) =>
        visit(entry, valuePath ? `${valuePath}.${index}` : String(index)),
      );
      return;
    }
    if (!isRecord(current)) {
      return;
    }
    for (const marker of ["$callback", "$stream", "$abortSignal", "$bytes"] as const) {
      if (marker in current) {
        throw new Error(`JSON-RPC wire marker is not allowed in registration arguments: ${marker}`);
      }
    }
    if (typeof current.$rpc === "string") {
      if (!allowed.has(valuePath)) {
        throw new Error(
          `JSON-RPC callback is not supported at registration argument path: ${valuePath}`,
        );
      }
      return;
    }
    for (const [key, entry] of Object.entries(current)) {
      visit(entry, valuePath ? `${valuePath}.${key}` : key);
    }
  };
  visit(value, "");
}

function isGatewayStopHookRegistration(
  registration: JsonRpcPluginRegistration,
): registration is JsonRpcPluginHookRegistration {
  return registration.type === "hook" && registration.hook === "gateway_stop";
}

function registerJsonRpcTool(
  api: OpenClawPluginApi,
  client: JsonRpcPluginClient,
  registration: JsonRpcPluginToolRegistration,
): void {
  const tool: AnyAgentTool = {
    name: registration.name,
    label: registration.name,
    description: registration.description,
    parameters: registration.parameters ?? EMPTY_OBJECT_SCHEMA,
    ...(registration.displaySummary ? { displaySummary: registration.displaySummary } : {}),
    async execute(toolCallId, params, signal, onUpdate) {
      return (await client.request(
        registration.method ?? DEFAULT_TOOL_METHOD,
        {
          tool: {
            name: registration.name,
          },
          toolCallId,
          params: toJsonRpcValue(params),
          ...(onUpdate ? { onUpdate } : {}),
        },
        { timeoutMs: registration.timeoutMs, signal },
      )) as Awaited<ReturnType<AnyAgentTool["execute"]>>;
    },
  };
  api.registerTool(tool);
}

function registerJsonRpcHook(
  api: OpenClawPluginApi,
  client: JsonRpcPluginClient,
  registration: JsonRpcPluginHookRegistration,
): void {
  if (!isPluginHookName(registration.hook)) {
    throw new Error(`unknown JSON-RPC plugin hook: ${registration.hook}`);
  }
  if (registration.hook === "tool_result_persist" || registration.hook === "before_message_write") {
    throw new Error(`JSON-RPC plugins cannot register synchronous hook: ${registration.hook}`);
  }
  const registerAsyncHook = api.on as (
    hookName: string,
    handler: (event: unknown, context: unknown) => Promise<unknown>,
    options?: { priority?: number; timeoutMs?: number },
  ) => void;
  registerAsyncHook(
    registration.hook,
    async (event: unknown, context: unknown) => {
      return await dispatchJsonRpcHook(client, registration, event, context);
    },
    registration.options,
  );
}

function registerJsonRpcGatewayStopHook(
  api: OpenClawPluginApi,
  client: JsonRpcPluginClient,
  registrations: readonly JsonRpcPluginHookRegistration[],
): void {
  if (registrations.length === 0) {
    api.on("gateway_stop", () => client.dispose());
    return;
  }
  const handler: PluginHookHandlerMap["gateway_stop"] = async (event, context) => {
    try {
      let result: unknown;
      for (const registration of registrations) {
        result = await dispatchJsonRpcHook(client, registration, event, context);
      }
      return result as void;
    } finally {
      await client.dispose();
    }
  };
  api.on("gateway_stop", handler, registrations[0]?.options);
}

function dispatchJsonRpcHook(
  client: JsonRpcPluginClient,
  registration: JsonRpcPluginHookRegistration,
  event: unknown,
  context: unknown,
): Promise<unknown> {
  return client.request(
    registration.method ?? DEFAULT_HOOK_METHOD,
    {
      hook: {
        name: registration.hook,
      },
      event: toJsonRpcValue(event),
      context: toJsonRpcValue(context),
    },
    { timeoutMs: registration.timeoutMs },
  );
}

function registerJsonRpcHttpRoute(
  api: OpenClawPluginApi,
  client: JsonRpcPluginClient,
  registration: JsonRpcPluginHttpRouteRegistration,
): void {
  api.registerHttpRoute({
    path: registration.path,
    auth: registration.auth,
    handler: async (req, res) => {
      const body = await readRequestBody(
        req,
        registration.maxBodyBytes ?? DEFAULT_HTTP_BODY_LIMIT_BYTES,
      );
      const result = await client.request(
        registration.method ?? DEFAULT_HTTP_METHOD,
        {
          route: {
            path: registration.path,
            auth: registration.auth,
          },
          request: {
            method: req.method ?? "GET",
            url: req.url ?? "/",
            headers: normalizeHeaders(req.headers),
            bodyBase64: body.toString("base64"),
          },
        },
        { timeoutMs: registration.timeoutMs },
      );
      writeJsonRpcHttpResponse(res, result);
      return true;
    },
    ...(registration.match ? { match: registration.match } : {}),
    ...(registration.gatewayRuntimeScopeSurface
      ? { gatewayRuntimeScopeSurface: registration.gatewayRuntimeScopeSurface }
      : {}),
    ...(registration.nodeCapability ? { nodeCapability: registration.nodeCapability } : {}),
    ...(registration.replaceExisting !== undefined
      ? { replaceExisting: registration.replaceExisting }
      : {}),
  });
}

function registerJsonRpcGatewayMethod(
  api: OpenClawPluginApi,
  client: JsonRpcPluginClient,
  registration: JsonRpcPluginGatewayMethodRegistration,
): void {
  api.registerGatewayMethod(
    registration.method,
    async ({ req, params, client: gatewayClient, respond }) => {
      const result = await client.request(
        registration.rpcMethod ?? DEFAULT_GATEWAY_METHOD,
        {
          method: registration.method,
          request: {
            id: req.id,
            method: req.method,
          },
          params: toJsonRpcValue(params),
          client: gatewayClient
            ? {
                connId: gatewayClient.connId,
                clientIp: gatewayClient.clientIp,
                scopes: gatewayClient.connect?.scopes,
              }
            : null,
        },
        { timeoutMs: registration.timeoutMs },
      );
      respondWithJsonRpcGatewayResult(respond, result);
    },
    registration.scope ? { scope: registration.scope } : undefined,
  );
}

class JsonRpcPluginClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stdoutBuffer = Buffer.alloc(0);
  private peer: JsonRpcPeer | undefined;
  private protocol: JsonRpcPluginProtocol;
  private initializing: Promise<unknown> | undefined;
  private disposed = false;

  constructor(
    private readonly api: OpenClawPluginApi,
    private readonly manifestOptions: JsonRpcManifestPluginOptions,
  ) {
    this.protocol = new JsonRpcPluginProtocol(
      api,
      new Set(manifestOptions.permissions?.host ?? []),
      () => this.requirePeer(),
      (method, params, options) => this.request(method, params, options),
    );
  }

  materialize(value: unknown): unknown {
    return this.protocol.materialize(value);
  }

  async request(
    method: string,
    params: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    rejectIfAborted(options.signal);
    await waitForAbortable(this.ensureInitialized(), options.signal);
    return this.protocol.materialize(
      await this.requirePeer().request(method, this.protocol.serialize(params), options),
    );
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop();
  }

  async stop(): Promise<void> {
    this.peer?.close(new Error("JSON-RPC plugin process was disposed"));
    this.peer = undefined;
    this.protocol.dispose(new Error("JSON-RPC plugin process was disposed"));
    this.stdoutBuffer = Buffer.alloc(0);
    const child = this.child;
    this.child = undefined;
    this.initializing = undefined;
    await stopJsonRpcChild(child);
  }

  private async ensureInitialized(): Promise<void> {
    this.ensureStarted();
    if (!this.initializing) {
      const initialization = this.requestRaw(
        "openclaw.initialize",
        {
          plugin: {
            id: this.api.id,
            name: this.api.name,
            version: this.api.version,
            description: this.api.description,
            source: this.api.source,
            rootDir: this.api.rootDir,
            registrationMode: this.api.registrationMode,
          },
          pluginConfig: toJsonRpcValue(this.api.pluginConfig ?? {}),
          protocol: {
            version: this.manifestOptions.protocolVersion,
            hostCapabilities: [...(this.manifestOptions.permissions?.host ?? [])],
            features: ["bidirectional", "callbacks", "cancellation", "streams", "subscriptions"],
          },
        },
        {
          timeoutMs:
            this.manifestOptions.process.initializationTimeoutMs ??
            DEFAULT_INITIALIZATION_TIMEOUT_MS,
        },
      )
        .then((result) => {
          if (!isRecord(result) || result.protocolVersion !== JSON_RPC_PLUGIN_PROTOCOL_VERSION) {
            throw new Error(
              "JSON-RPC plugin initialization did not acknowledge protocol version 1",
            );
          }
        })
        .catch(async (error: unknown) => {
          if (this.initializing === initialization) {
            this.initializing = undefined;
          }
          await this.stop();
          throw error;
        });
      this.initializing = initialization;
    }
    await this.initializing;
  }

  private ensureStarted(): void {
    if (this.disposed) {
      throw new Error("JSON-RPC plugin process was disposed");
    }
    if (this.child) {
      return;
    }
    const env =
      this.manifestOptions.process.inheritEnv === true
        ? {
            ...process.env,
            ...this.manifestOptions.process.env,
          }
        : { ...this.manifestOptions.process.env };
    const spawnInvocation = resolveJsonRpcSpawnInvocation({
      command: resolveJsonRpcProcessCommand(this.api, this.manifestOptions.process.command),
      args: [...(this.manifestOptions.process.args ?? [])],
      env,
    });
    const cwd = this.manifestOptions.process.cwd
      ? this.api.resolvePath(this.manifestOptions.process.cwd)
      : this.api.rootDir;
    const child = spawn(spawnInvocation.command, spawnInvocation.argv, {
      cwd,
      detached: process.platform !== "win32",
      env,
      shell: spawnInvocation.shell,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: spawnInvocation.windowsHide,
    });
    this.child = child;
    this.peer = new JsonRpcPeer({
      write: child.stdin,
      requestTimeoutMs: this.manifestOptions.process.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      maxPendingRequests:
        this.manifestOptions.process.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS,
      requestHandlers: this.protocol.requestHandlers,
      notificationHandlers: this.protocol.notificationHandlers,
      onProtocolError: (message) => this.api.logger.warn(`[${this.api.id}] ${message}`),
    });
    child.stdout.on("data", (chunk: Buffer | string) => this.handleStdoutChunk(chunk));
    child.once("error", (error) => {
      if (this.child === child) {
        this.peer?.close(error);
      }
    });
    child.once("close", (code, signal) => {
      if (this.child !== child) {
        return;
      }
      const label = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      this.peer?.close(new Error(`JSON-RPC plugin process closed with ${label}`));
      this.protocol.dispose(new Error(`JSON-RPC plugin process closed with ${label}`));
      this.child = undefined;
      this.peer = undefined;
      this.stdoutBuffer = Buffer.alloc(0);
      this.initializing = undefined;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (this.manifestOptions.process.logStderr === false) {
        return;
      }
      const message = String(chunk).trim();
      if (message) {
        this.api.logger.warn(`[${this.api.id}] ${message}`);
      }
    });
  }

  private requestRaw(
    method: string,
    params: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    this.ensureStarted();
    return this.requirePeer().request(method, this.protocol.serialize(params), options);
  }

  private handleStdoutChunk(chunk: Buffer | string): void {
    let remaining = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    const maxFrameBytes = this.manifestOptions.process.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    while (true) {
      const newlineIndex = remaining.indexOf(0x0a);
      if (newlineIndex === -1) {
        if (this.stdoutBuffer.length + remaining.length > maxFrameBytes) {
          this.rejectOversizedFrame();
          return;
        }
        this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, remaining]);
        return;
      }
      const frameTail = remaining.subarray(0, newlineIndex);
      if (this.stdoutBuffer.length + frameTail.length > maxFrameBytes) {
        this.rejectOversizedFrame();
        return;
      }
      const frame = Buffer.concat([this.stdoutBuffer, frameTail]);
      this.stdoutBuffer = Buffer.alloc(0);
      this.handleFrame(frame);
      remaining = remaining.subarray(newlineIndex + 1);
    }
  }

  private rejectOversizedFrame(): void {
    this.stdoutBuffer = Buffer.alloc(0);
    this.api.logger.warn(`JSON-RPC plugin ${this.api.id} exceeded the frame size limit`);
    void this.stop();
  }

  private handleFrame(frame: Buffer): void {
    const trimmed = frame.toString("utf8").trim();
    if (!trimmed) {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(trimmed) as unknown;
    } catch {
      this.api.logger.warn(`Ignoring invalid JSON-RPC message from plugin ${this.api.id}`);
      return;
    }
    this.peer?.handle(message);
  }

  private requirePeer(): JsonRpcPeer {
    if (!this.peer) {
      throw new Error("JSON-RPC plugin process is not running");
    }
    return this.peer;
  }
}

function resolveJsonRpcSpawnInvocation(params: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}): {
  command: string;
  argv: string[];
  shell?: boolean;
  windowsHide?: boolean;
} {
  const program = resolveWindowsSpawnProgram({
    command: params.command,
    platform: process.platform,
    env: params.env,
    execPath: process.execPath,
    allowShellFallback: false,
  });
  return materializeWindowsSpawnProgram(program, params.args);
}

function resolveJsonRpcProcessCommand(api: OpenClawPluginApi, command: string): string {
  if (path.isAbsolute(command)) {
    return command;
  }
  if (!command.includes("/") && !command.includes("\\")) {
    return command;
  }
  return api.resolvePath(command);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

function hasChildExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function rejectIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("JSON-RPC plugin request aborted");
  }
}

function waitForAbortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  rejectIfAborted(signal);
  if (!signal) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", handleAbort);
    const handleAbort = () => {
      cleanup();
      reject(new Error("JSON-RPC plugin request aborted"));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function stopJsonRpcChild(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!child || hasChildExited(child)) {
    return;
  }
  const closePromise = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  try {
    child.stdin.end();
  } catch {
    // best-effort
  }
  await Promise.race([closePromise, delay(PROCESS_CLOSE_TIMEOUT_MS)]);
  if (hasChildExited(child) || !child.pid) {
    return;
  }
  killProcessTree(child.pid, { graceMs: PROCESS_TREE_KILL_GRACE_MS });
  await Promise.race([closePromise, delay(PROCESS_CLOSE_TIMEOUT_MS)]);
  if (hasChildExited(child) || !child.pid) {
    return;
  }
  signalProcessTree(child.pid, "SIGKILL");
  await Promise.race([closePromise, delay(SIGKILL_REAP_TIMEOUT_MS)]);
}

function toJsonRpcValue(value: unknown): JsonRpcPluginJsonValue {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- JSON-RPC params must be JSON-serialized, not cloned with Date/Map/object prototypes intact.
  return JSON.parse(JSON.stringify(value ?? null)) as JsonRpcPluginJsonValue;
}

function normalizeHeaders(headers: IncomingMessage["headers"]): JsonRpcPluginJsonObject {
  const normalized: JsonRpcPluginJsonObject = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized[key] = value;
    } else if (Array.isArray(value)) {
      normalized[key] = value;
    }
  }
  return normalized;
}

async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req as Readable) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new Error(`JSON-RPC plugin HTTP request body exceeded ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function writeJsonRpcHttpResponse(res: ServerResponse, result: unknown): void {
  if (!isRecord(result)) {
    res.statusCode = 502;
    res.end("JSON-RPC plugin returned an invalid HTTP response");
    return;
  }
  const status = typeof result.status === "number" ? result.status : 200;
  res.statusCode = status;
  if (isRecord(result.headers)) {
    for (const [key, value] of Object.entries(result.headers)) {
      if (typeof value === "string" || Array.isArray(value)) {
        res.setHeader(key, value);
      }
    }
  }
  if (typeof result.bodyBase64 === "string") {
    res.end(Buffer.from(result.bodyBase64, "base64"));
    return;
  }
  res.end(typeof result.bodyText === "string" ? result.bodyText : "");
}

function respondWithJsonRpcGatewayResult(respond: RespondFn, result: unknown): void {
  if (isRecord(result) && typeof result.ok === "boolean") {
    respond(
      result.ok,
      result.payload,
      toGatewayError(result.error),
      isRecord(result.meta) ? result.meta : undefined,
    );
    return;
  }
  respond(true, result);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toGatewayError(error: unknown): ErrorShape | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const message = typeof error.message === "string" ? error.message : "Plugin request failed";
  const code = typeof error.code === "string" ? error.code : "plugin_error";
  return {
    code,
    message,
    ...(error.details !== undefined ? { details: toJsonRpcValue(error.details) } : {}),
  };
}
