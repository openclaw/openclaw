// CLI adapter for invoking native provider hooks through direct relay or gateway fallback.
import { Readable, Writable } from "node:stream";
import {
  invokeNativeHookRelayBridge,
  isNativeHookRelayBridgeStaleRegistrationError,
  renderNativeHookRelayUnavailableResponse,
  type NativeHookRelayProcessResponse,
} from "../agents/harness/native-hook-relay.js";
import { callGateway } from "../gateway/call.js";
import { ADMIN_SCOPE } from "../gateway/method-scopes.js";
import { resolveSafeTimeoutDelayMs } from "../utils/timer-delay.js";
import { parseTimeoutMsWithFallback } from "./parse-timeout.js";

const MAX_NATIVE_HOOK_STDIN_BYTES = 1024 * 1024;
const NATIVE_HOOK_RELAY_PROCESS_DEADLINE_GRACE_MS = 2_000;

/** Upper bound for total relay CLI process lifetime derived from --timeout. */
export function resolveNativeHookRelayProcessDeadlineMs(timeoutMs: number): number {
  return resolveSafeTimeoutDelayMs(timeoutMs * 2 + NATIVE_HOOK_RELAY_PROCESS_DEADLINE_GRACE_MS);
}

/** User-facing flags for the native hook relay command. */
export type NativeHookRelayCliOptions = {
  provider?: string;
  relayId?: string;
  generation?: string;
  event?: string;
  preToolUseUnavailable?: string;
  timeout?: string;
};

type NativeHookRelayCliDeps = {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  invokeBridge?: typeof invokeNativeHookRelayBridge;
  callGateway?: typeof callGateway;
};

/** Run one native hook relay invocation from stdin JSON to stdout/stderr response streams. */
export async function runNativeHookRelayCli(
  opts: NativeHookRelayCliOptions,
  deps: NativeHookRelayCliDeps = {},
): Promise<number> {
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const invokeBridge = deps.invokeBridge ?? invokeNativeHookRelayBridge;
  const callGatewayFn = deps.callGateway ?? callGateway;
  const provider = readRequiredOption(opts.provider, "provider");
  const relayId = readRequiredOption(opts.relayId, "relay-id");
  const generation = opts.generation?.trim() || undefined;
  const event = readRequiredOption(opts.event, "event");
  let timeoutMs: number;
  try {
    timeoutMs = parseTimeoutMsWithFallback(opts.timeout, 5_000);
  } catch (error) {
    await writeTextAsync(stderr, formatRelayCliError("invalid native hook timeout", error));
    return 1;
  }

  let rawPayload: unknown;
  try {
    const rawInput = await readStreamText(stdin, MAX_NATIVE_HOOK_STDIN_BYTES, timeoutMs);
    rawPayload = rawInput.trim() ? JSON.parse(rawInput) : null;
  } catch (error) {
    await writeTextAsync(stderr, formatRelayCliError("failed to read native hook input", error));
    return 1;
  }

  try {
    const response = await invokeBridge({
      provider,
      relayId,
      generation,
      event,
      rawPayload,
      registrationTimeoutMs: 100,
      timeoutMs,
    });
    await writeTextAsync(stdout, response.stdout);
    await writeTextAsync(stderr, response.stderr);
    return response.exitCode;
  } catch (error) {
    if (isNativeHookRelayBridgeStaleRegistrationError(error)) {
      await writeTextAsync(stderr, formatRelayCliError("native hook relay unavailable", error));
      const response = renderNativeHookRelayUnavailableResponse({
        provider,
        event,
        preToolUseUnavailable: opts.preToolUseUnavailable,
        message: "Native hook relay unavailable",
      });
      await writeTextAsync(stdout, response.stdout);
      await writeTextAsync(stderr, response.stderr);
      return response.exitCode;
    }
    // Fall through to the gateway path for embedded/local gateway cases and
    // older registrations that predate the direct relay bridge.
  }

  try {
    const response = await callGatewayFn<NativeHookRelayProcessResponse>({
      method: "nativeHook.invoke",
      params: { provider, relayId, generation, event, rawPayload },
      timeoutMs,
      scopes: [ADMIN_SCOPE],
    });
    await writeTextAsync(stdout, response.stdout);
    await writeTextAsync(stderr, response.stderr);
    return response.exitCode;
  } catch (error) {
    await writeTextAsync(stderr, formatRelayCliError("native hook relay unavailable", error));
    const response = renderNativeHookRelayUnavailableResponse({
      provider,
      event,
      preToolUseUnavailable: opts.preToolUseUnavailable,
      message: "Native hook relay unavailable",
    });
    await writeTextAsync(stdout, response.stdout);
    await writeTextAsync(stderr, response.stderr);
    return response.exitCode;
  }
}

export type NativeHookRelayProcessExitDeps = {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  exit?: (code: number) => void;
};

/** Drain relay stdout/stderr so Codex receives complete hook decision JSON before exit. */
export async function flushNativeHookRelayProcessStreams(
  stdout: NodeJS.WritableStream = process.stdout,
  stderr: NodeJS.WritableStream = process.stderr,
): Promise<void> {
  await Promise.all([flushWritableStream(stdout), flushWritableStream(stderr)]);
}

/** Flush relay output streams, then force-exit the relay CLI process. */
export async function exitNativeHookRelayProcess(
  exitCode: number,
  deps: NativeHookRelayProcessExitDeps = {},
): Promise<void> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  await flushNativeHookRelayProcessStreams(stdout, stderr);
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  exit(exitCode);
}

function readRequiredOption(value: string | undefined, name: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new Error(`Missing required option --${name}`);
}

async function readStreamText(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
  timeoutMs: number,
): Promise<string> {
  const safeTimeoutMs = resolveSafeTimeoutDelayMs(timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const readTask = (async () => {
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
  })();

  try {
    return await Promise.race([
      readTask,
      new Promise<string>((_resolve, reject) => {
        timer = setTimeout(() => {
          destroyReadableStream(stream);
          reject(new Error(`native hook stdin read timed out after ${safeTimeoutMs}ms`));
        }, safeTimeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function destroyReadableStream(stream: NodeJS.ReadableStream): void {
  if (typeof (stream as NodeJS.ReadStream).destroy === "function") {
    (stream as NodeJS.ReadStream).destroy();
  }
}

async function writeTextAsync(
  stream: NodeJS.WritableStream,
  value: string | undefined,
): Promise<void> {
  if (!value) {
    return;
  }
  await writeChunkAsync(stream, value);
}

function writeChunkAsync(stream: NodeJS.WritableStream, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((stream as NodeJS.WriteStream).destroyed || !stream.writable) {
      resolve();
      return;
    }
    try {
      const onDone = (err?: Error | null) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      };
      const canContinue = stream.write(chunk, onDone);
      if (!canContinue) {
        stream.once("drain", () => {
          // The write callback still signals completion for this chunk.
        });
      }
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

async function flushWritableStream(stream: NodeJS.WritableStream): Promise<void> {
  if ((stream as NodeJS.WriteStream).destroyed || !stream.writable) {
    return;
  }
  await new Promise<void>((resolve) => {
    try {
      stream.write("", () => resolve());
    } catch {
      resolve();
    }
  });
}

function formatRelayCliError(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${message}\n`;
}

/** Create a readable text stream for relay CLI tests. */
export function createReadableTextStream(text: string): NodeJS.ReadableStream {
  return Readable.from([text]);
}

/** Create a writable stream that exposes captured text for relay CLI tests. */
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
