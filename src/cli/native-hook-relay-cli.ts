import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  invokeNativeHookRelayBridge,
  renderNativeHookRelayUnavailableResponse,
  type NativeHookRelayProcessResponse,
} from "../agents/harness/native-hook-relay.js";
import { callGateway } from "../gateway/call.js";
import { ADMIN_SCOPE } from "../gateway/method-scopes.js";

const MAX_NATIVE_HOOK_STDIN_BYTES = 1024 * 1024;

export type NativeHookRelayCliOptions = {
  provider?: string;
  relayId?: string;
  event?: string;
  timeout?: string;
};

type NativeHookRelayCliDeps = {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  callGateway?: typeof callGateway;
};

export async function runNativeHookRelayCli(
  opts: NativeHookRelayCliOptions,
  deps: NativeHookRelayCliDeps = {},
): Promise<number> {
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const callGatewayFn = deps.callGateway ?? callGateway;
  const provider = readRequiredOption(opts.provider, "provider");
  const relayId = readRequiredOption(opts.relayId, "relay-id");
  const event = readRequiredOption(opts.event, "event");
  const timeoutMs = normalizeTimeoutMs(opts.timeout);

  let rawPayload: unknown;
  try {
    const rawInput = await readStreamText(stdin, MAX_NATIVE_HOOK_STDIN_BYTES);
    rawPayload = rawInput.trim() ? JSON.parse(rawInput) : null;
  } catch (error) {
    writeText(stderr, formatRelayCliError("failed to read native hook input", error));
    return 1;
  }

  let bridgeError: unknown;
  try {
    const response = await invokeNativeHookRelayBridge({
      provider,
      relayId,
      event,
      rawPayload,
      registrationTimeoutMs: timeoutMs,
      timeoutMs,
    });
    writeText(stdout, response.stdout);
    writeText(stderr, response.stderr);
    return response.exitCode;
  } catch (error) {
    bridgeError = error;
    // Fall through to the gateway path for embedded/local gateway cases and
    // older registrations that predate the direct relay bridge.
  }

  try {
    const response = await callGatewayFn<NativeHookRelayProcessResponse>({
      method: "nativeHook.invoke",
      params: { provider, relayId, event, rawPayload },
      timeoutMs,
      scopes: [ADMIN_SCOPE],
    });
    writeText(stdout, response.stdout);
    writeText(stderr, response.stderr);
    return response.exitCode;
  } catch (error) {
    const message = formatNativeHookRelayUnavailableDiagnostic({
      provider,
      relayId,
      event,
      bridgeError,
      gatewayError: error,
    });
    writeText(stderr, formatRelayCliError("native hook relay unavailable", message));
    const response = renderNativeHookRelayUnavailableResponse({
      provider,
      event,
      message,
    });
    writeText(stdout, response.stdout);
    writeText(stderr, response.stderr);
    return response.exitCode;
  }
}

function readRequiredOption(value: string | undefined, name: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new Error(`Missing required option --${name}`);
}

async function readStreamText(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      throw new Error(`native hook input exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function normalizeTimeoutMs(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 5_000;
}

function writeText(stream: NodeJS.WritableStream, value: string | undefined): void {
  if (value) {
    stream.write(value);
  }
}

function formatRelayCliError(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${message}\n`;
}

function formatNativeHookRelayUnavailableDiagnostic(params: {
  provider: string;
  relayId: string;
  event: string;
  bridgeError: unknown;
  gatewayError: unknown;
}): string {
  return [
    "Native hook relay unavailable",
    "owner=OpenClaw gateway native-hook-relay",
    `provider=${params.provider}`,
    `event=${params.event}`,
    `relayId=${params.relayId}`,
    `bridgeRegistry=${nativeHookRelayBridgeRegistryPath(params.relayId)}`,
    `bridge=${formatRelayDiagnosticError(params.bridgeError)}`,
    `gateway=${formatRelayDiagnosticError(params.gatewayError)}`,
    "remediation=restart the active OpenClaw agent run so native hook commands are regenerated; if every run reports this, restart the OpenClaw gateway",
  ].join("; ");
}

function formatRelayDiagnosticError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return sanitizeRelayDiagnostic(error.message);
  }
  if (typeof error === "string" && error.trim()) {
    return sanitizeRelayDiagnostic(error);
  }
  return "unknown";
}

function sanitizeRelayDiagnostic(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function nativeHookRelayBridgeRegistryPath(relayId: string): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "nouid";
  return path.join(
    tmpdir(),
    `openclaw-native-hook-relays-${uid}`,
    `${nativeHookRelayBridgeKey(relayId)}.json`,
  );
}

function nativeHookRelayBridgeKey(relayId: string): string {
  return createHash("sha256").update(relayId).digest("hex").slice(0, 32);
}

export function createReadableTextStream(text: string): NodeJS.ReadableStream {
  return Readable.from([text]);
}

export function createWritableTextBuffer(): NodeJS.WritableStream & { text: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      callback();
    },
  });
  return Object.assign(stream, {
    text: () => Buffer.concat(chunks).toString("utf8"),
  });
}
