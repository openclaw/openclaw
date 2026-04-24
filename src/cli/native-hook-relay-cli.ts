import { Readable, Writable } from "node:stream";
import type { NativeHookRelayProcessResponse } from "../agents/harness/native-hook-relay.js";
import { callGateway } from "../gateway/call.js";
import { ADMIN_SCOPE } from "../gateway/method-scopes.js";

export type NativeHookRelayCliOptions = {
  provider?: string;
  relayId?: string;
  event?: string;
  timeout?: string;
};

export type NativeHookRelayCliDeps = {
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

  let rawPayload: unknown;
  try {
    const rawInput = await readStreamText(stdin);
    rawPayload = rawInput.trim() ? JSON.parse(rawInput) : null;
  } catch (error) {
    writeText(stderr, formatRelayCliError("failed to read native hook input", error));
    return 1;
  }

  try {
    const response = await callGatewayFn<NativeHookRelayProcessResponse>({
      method: "nativeHook.invoke",
      params: { provider, relayId, event, rawPayload },
      timeoutMs: normalizeTimeoutMs(opts.timeout),
      scopes: [ADMIN_SCOPE],
    });
    writeText(stdout, response.stdout);
    writeText(stderr, response.stderr);
    return response.exitCode;
  } catch (error) {
    if (process.env.OPENCLAW_NATIVE_HOOK_RELAY_DEBUG === "1") {
      writeText(stderr, formatRelayCliError("native hook relay unavailable", error));
    }
    // Hook relay availability should not make the native harness fail closed.
    return 0;
  }
}

function readRequiredOption(value: string | undefined, name: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new Error(`Missing required option --${name}`);
}

async function readStreamText(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
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
