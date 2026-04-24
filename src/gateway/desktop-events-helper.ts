import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { loadConfig, resolveConfigPath, resolveStateDir } from "../config/config.js";
import { loadGatewayTlsRuntime } from "../infra/tls/gateway.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../utils/message-channel.js";
import { GatewayClient, type GatewayClientOptions } from "./client.js";
import {
  buildGatewayConnectionDetails,
  ensureExplicitGatewayAuth,
  resolveExplicitGatewayAuth,
} from "./call.js";
import { resolveGatewayCredentialsFromConfig } from "./credentials.js";
import { APPROVALS_SCOPE } from "./method-scopes.js";
import { PROTOCOL_VERSION, type EventFrame, type HelloOk } from "./protocol/index.js";

export type DesktopApprovalDecision = "allow-once" | "deny";

export type DesktopEventsBridgeOptions = {
  url?: string;
  token?: string;
  password?: string;
  configPath?: string;
  stdout?: Pick<NodeJS.WritableStream, "write">;
  stderr?: Pick<NodeJS.WritableStream, "write">;
  instanceId?: string;
  clientFactory?: (options: GatewayClientOptions) => DesktopEventsGatewayClient;
};

export type DesktopEventsRunOptions = DesktopEventsBridgeOptions & {
  stdin?: NodeJS.ReadableStream;
};

export type DesktopEventsGatewayClient = {
  start: () => void;
  stop: () => void;
  request: <T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: { expectFinal?: boolean },
  ) => Promise<T>;
};

export type DesktopEventsBridge = {
  start: () => Promise<void>;
  stop: () => void;
  handleCommandLine: (line: string) => Promise<void>;
};

const VALID_APPROVAL_DECISIONS = new Set<DesktopApprovalDecision>(["allow-once", "deny"]);

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeJsonLine(target: Pick<NodeJS.WritableStream, "write">, value: unknown) {
  target.write(`${JSON.stringify(value)}\n`);
}

function writeBridgeError(
  stdout: Pick<NodeJS.WritableStream, "write">,
  code: string,
  message: string,
  requestId?: string,
) {
  writeJsonLine(stdout, {
    type: "bridge.error",
    code,
    message,
    requestId: requestId ?? null,
  });
}

async function resolveTlsFingerprint(params: {
  url: string;
  urlOverride?: string;
  config: ReturnType<typeof loadConfig>;
}): Promise<string | undefined> {
  const { url, urlOverride, config } = params;
  const remote = config.gateway?.mode === "remote" ? config.gateway.remote : undefined;
  if (!urlOverride && remote?.url && typeof remote.tlsFingerprint === "string") {
    return trimToUndefined(remote.tlsFingerprint);
  }

  const useLocalTls = config.gateway?.tls?.enabled === true && !urlOverride && url.startsWith("wss://");
  if (!useLocalTls) {
    return undefined;
  }

  const tlsRuntime = await loadGatewayTlsRuntime(config.gateway?.tls);
  return tlsRuntime?.enabled ? tlsRuntime.fingerprintSha256 : undefined;
}

async function buildClientOptions(
  options: DesktopEventsBridgeOptions,
  handlers: Pick<GatewayClientOptions, "onHelloOk" | "onEvent" | "onConnectError" | "onClose" | "onGap">,
): Promise<GatewayClientOptions & { resolvedUrl: string }> {
  const config = loadConfig();
  const configPath =
    trimToUndefined(options.configPath) ?? resolveConfigPath(process.env, resolveStateDir(process.env));
  const urlOverride = trimToUndefined(options.url);
  const explicitAuth = resolveExplicitGatewayAuth({
    token: options.token,
    password: options.password,
  });

  const connection = buildGatewayConnectionDetails({
    config,
    url: urlOverride,
    configPath,
  });
  const credentials = resolveGatewayCredentialsFromConfig({
    cfg: config,
    explicitAuth,
    urlOverride,
    urlOverrideSource: urlOverride ? "cli" : undefined,
    remotePasswordPrecedence: "env-first",
  });
  ensureExplicitGatewayAuth({
    urlOverride,
    urlOverrideSource: urlOverride ? "cli" : undefined,
    explicitAuth,
    resolvedAuth: credentials,
    errorHint: "Fix: pass --token or --password, or configure gateway auth in OpenClaw.",
    configPath,
  });
  const tlsFingerprint = await resolveTlsFingerprint({
    url: connection.url,
    urlOverride,
    config,
  });

  return {
    url: connection.url,
    resolvedUrl: connection.url,
    token: credentials.token,
    password: credentials.password,
    tlsFingerprint,
    instanceId: options.instanceId ?? randomUUID(),
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    clientDisplayName: "Jarvis Desktop Live Bridge",
    clientVersion: "dev",
    platform: process.platform,
    mode: GATEWAY_CLIENT_MODES.CLI,
    role: "operator",
    scopes: [APPROVALS_SCOPE],
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    ...handlers,
  };
}

function normalizeEventFrame(event: EventFrame) {
  return {
    type: "gateway.event",
    event: event.event,
    payload: event.payload ?? null,
    seq: event.seq ?? null,
    stateVersion: event.stateVersion ?? null,
    frame: event,
  };
}

function normalizeHello(hello: HelloOk, gatewayUrl: string) {
  return {
    type: "bridge.ready",
    gatewayUrl,
    protocol: hello.protocol ?? PROTOCOL_VERSION,
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    role: "operator",
    scopes: [APPROVALS_SCOPE],
    hello,
  };
}

function parseResolveCommand(value: unknown):
  | {
      ok: true;
      requestId?: string;
      id: string;
      decision: DesktopApprovalDecision;
    }
  | { ok: false; requestId?: string; code: string; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, code: "invalid_command", message: "Command must be a JSON object." };
  }

  const record = value as Record<string, unknown>;
  const requestId = trimToUndefined(record.requestId);
  if (record.type !== "approval.resolve") {
    return {
      ok: false,
      requestId,
      code: "unknown_command",
      message: "Unsupported desktop-events command.",
    };
  }

  const id = trimToUndefined(record.id);
  if (!id) {
    return {
      ok: false,
      requestId,
      code: "invalid_command",
      message: "approval.resolve requires a non-empty id.",
    };
  }

  const decision = trimToUndefined(record.decision);
  if (!decision || !VALID_APPROVAL_DECISIONS.has(decision as DesktopApprovalDecision)) {
    return {
      ok: false,
      requestId,
      code: "invalid_decision",
      message: "approval.resolve decision must be allow-once or deny.",
    };
  }

  return {
    ok: true,
    requestId,
    id,
    decision: decision as DesktopApprovalDecision,
  };
}

export function createDesktopEventsBridge(
  options: DesktopEventsBridgeOptions = {},
): DesktopEventsBridge {
  const stdout = options.stdout ?? process.stdout;
  let client: DesktopEventsGatewayClient | null = null;
  let gatewayUrl: string | null = null;

  async function start() {
    if (client) {
      return;
    }

    const clientOptions = await buildClientOptions(options, {
      onHelloOk: (hello) => {
        writeJsonLine(stdout, normalizeHello(hello, gatewayUrl ?? "unknown"));
      },
      onEvent: (event) => {
        writeJsonLine(stdout, normalizeEventFrame(event));
      },
      onConnectError: (error) => {
        writeJsonLine(stdout, {
          type: "bridge.state",
          state: "error",
          gatewayUrl: gatewayUrl ?? "unknown",
          error: {
            message: toErrorMessage(error),
          },
        });
      },
      onClose: (code, reason) => {
        writeJsonLine(stdout, {
          type: "bridge.state",
          state: "disconnected",
          gatewayUrl: gatewayUrl ?? "unknown",
          code,
          reason,
        });
      },
      onGap: (info) => {
        writeJsonLine(stdout, {
          type: "bridge.state",
          state: "gap",
          gatewayUrl: gatewayUrl ?? "unknown",
          ...info,
        });
      },
    });

    gatewayUrl = clientOptions.resolvedUrl;
    writeJsonLine(stdout, {
      type: "bridge.state",
      state: "connecting",
      gatewayUrl,
      protocol: PROTOCOL_VERSION,
      scopes: [APPROVALS_SCOPE],
    });

    client = options.clientFactory
      ? options.clientFactory(clientOptions)
      : new GatewayClient(clientOptions);
    client.start();
  }

  function stop() {
    client?.stop();
    client = null;
  }

  async function handleCommandLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      writeBridgeError(stdout, "invalid_json", "Command must be valid JSON.");
      return;
    }

    const command = parseResolveCommand(parsed);
    if (!command.ok) {
      writeBridgeError(stdout, command.code, command.message, command.requestId);
      return;
    }

    if (!client) {
      writeJsonLine(stdout, {
        type: "approval.resolve.result",
        requestId: command.requestId ?? null,
        id: command.id,
        decision: command.decision,
        ok: false,
        error: {
          code: "bridge_not_started",
          message: "Gateway bridge is not started.",
        },
      });
      return;
    }

    try {
      const result = await client.request("exec.approval.resolve", {
        id: command.id,
        decision: command.decision,
      });
      writeJsonLine(stdout, {
        type: "approval.resolve.result",
        requestId: command.requestId ?? null,
        id: command.id,
        decision: command.decision,
        ok: true,
        result,
      });
    } catch (error) {
      writeJsonLine(stdout, {
        type: "approval.resolve.result",
        requestId: command.requestId ?? null,
        id: command.id,
        decision: command.decision,
        ok: false,
        error: {
          code: "approval_resolve_failed",
          message: toErrorMessage(error),
        },
      });
    }
  }

  return {
    start,
    stop,
    handleCommandLine,
  };
}

export async function runDesktopEventsHelper(
  options: DesktopEventsRunOptions = {},
): Promise<void> {
  const bridge = createDesktopEventsBridge(options);
  await bridge.start();

  const input = options.stdin ?? process.stdin;
  const lines = createInterface({
    input,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of lines) {
    await bridge.handleCommandLine(line);
  }

  bridge.stop();
}
