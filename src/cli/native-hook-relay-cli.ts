import { racePromiseWithAbortSignal } from "../../packages/retry/src/index.js";
import {
  invokeNativeHookRelayBridge,
  isNativeHookRelayBridgeStaleRegistrationError,
  renderNativeHookRelayUnavailableResponse,
} from "../agents/harness/native-hook-relay-client.js";
import { invokeRemoteNativeHookRelay } from "../agents/harness/native-hook-relay-remote-client.js";
import type { NativeHookRelayProcessResponse } from "../agents/harness/native-hook-relay-types.js";
import type { CallGatewayOptions } from "../gateway/call.js";
import { ADMIN_SCOPE } from "../gateway/operator-scopes.js";
import { setSafeTimeout } from "../utils/timer-delay.js";
import { parseTimeoutMsWithFallback } from "./parse-timeout.js";

const MAX_NATIVE_HOOK_STDIN_BYTES = 1024 * 1024;

/** User-facing flags for the native hook relay command. */
export type NativeHookRelayCliOptions = Partial<
  Record<(typeof NATIVE_HOOK_RELAY_VALUE_FLAGS)[keyof typeof NATIVE_HOOK_RELAY_VALUE_FLAGS], string>
>;

const NATIVE_HOOK_RELAY_VALUE_FLAGS = {
  "--provider": "provider",
  "--relay-id": "relayId",
  "--state-db": "stateDb",
  "--remote-credential": "remoteCredential",
  "--generation": "generation",
  "--event": "event",
  "--pre-tool-use-unavailable": "preToolUseUnavailable",
  "--timeout": "timeout",
} as const;

type NativeHookRelayDeadline = ReturnType<typeof createNativeHookRelayDeadline>;

class NativeHookRelayDeadlineError extends Error {
  constructor(timeoutMs: number) {
    super(`native hook relay timed out after ${timeoutMs}ms`);
    this.name = "NativeHookRelayDeadlineError";
  }
}

/** Parse and run the internal native relay directly from the process argument vector. */
export async function runNativeHookRelayCliFromArgv(argv: string[]): Promise<number> {
  return await runNativeHookRelayCli(parseNativeHookRelayCliOptions(argv));
}

function parseNativeHookRelayCliOptions(argv: string[]): NativeHookRelayCliOptions {
  const relayIndex = argv.findIndex((arg, index) => arg === "relay" && argv[index - 1] === "hooks");
  if (relayIndex < 0) {
    throw new Error("native hook relay command path is required");
  }
  const opts: NativeHookRelayCliOptions = {};
  for (let index = relayIndex + 1; index < argv.length; index += 1) {
    const rawFlag = argv[index] ?? "";
    const equalsIndex = rawFlag.indexOf("=");
    const flag = equalsIndex > 0 ? rawFlag.slice(0, equalsIndex) : rawFlag;
    const key = NATIVE_HOOK_RELAY_VALUE_FLAGS[flag as keyof typeof NATIVE_HOOK_RELAY_VALUE_FLAGS];
    if (!key) {
      throw new Error(`unknown native hook relay option: ${rawFlag}`);
    }
    const value = equalsIndex > 0 ? rawFlag.slice(equalsIndex + 1) : argv[++index];
    if (!value) {
      throw new Error(`native hook relay option ${flag} requires a value`);
    }
    opts[key] = value;
  }
  return opts;
}

/** Run one native hook relay invocation from stdin JSON to stdout/stderr response streams. */
export async function runNativeHookRelayCli(opts: NativeHookRelayCliOptions): Promise<number> {
  const { stdin, stdout, stderr } = process;
  const provider = readRequiredOption(opts.provider, "provider");
  const relayId = readRequiredOption(opts.relayId, "relay-id");
  const generation = opts.generation?.trim() || undefined;
  const event = readRequiredOption(opts.event, "event");
  let timeoutMs: number;
  try {
    timeoutMs = parseTimeoutMsWithFallback(opts.timeout, 5_000, { invalidType: "error" });
  } catch (error) {
    writeText(stderr, formatRelayCliError("invalid native hook timeout", error));
    return 1;
  }

  const deadline = createNativeHookRelayDeadline(timeoutMs);
  const writeResponse = (response: NativeHookRelayProcessResponse): number => {
    writeText(stdout, response.stdout);
    writeText(stderr, response.stderr);
    return response.exitCode;
  };
  const unavailable = (message = "Native hook relay unavailable") =>
    writeResponse(
      renderNativeHookRelayUnavailableResponse({
        provider,
        event,
        preToolUseUnavailable: opts.preToolUseUnavailable,
        message,
      }),
    );
  const timedOut = (error: NativeHookRelayDeadlineError) => {
    writeText(stderr, formatRelayCliError("native hook relay timed out", error));
    return unavailable("Native hook relay timed out");
  };
  try {
    let rawPayload: unknown;
    try {
      const rawInput = await readStreamText(stdin, MAX_NATIVE_HOOK_STDIN_BYTES, deadline);
      rawPayload = rawInput.trim() ? JSON.parse(rawInput) : null;
    } catch (error) {
      if (isNativeHookRelayDeadlineError(error)) {
        return timedOut(error);
      }
      writeText(stderr, formatRelayCliError("failed to read native hook input", error));
      return 1;
    }

    if (opts.remoteCredential) {
      try {
        return writeResponse(
          await withNativeHookRelayDeadline(
            deadline,
            invokeRemoteNativeHookRelay(
              opts.remoteCredential,
              { provider, relayId, generation, event, rawPayload },
              deadline.signal,
            ),
          ),
        );
      } catch (error) {
        if (isNativeHookRelayDeadlineError(error)) {
          return timedOut(error);
        }
        writeText(stderr, formatRelayCliError("native hook relay unavailable", error));
        // Dedicated mode never falls back to local storage or operator credentials.
        return unavailable();
      }
    }

    try {
      const remainingMs = remainingNativeHookRelayDeadlineMs(deadline);
      const response = await withNativeHookRelayDeadline(
        deadline,
        invokeNativeHookRelayBridge({
          provider,
          relayId,
          stateDbPath: opts.stateDb?.trim() || undefined,
          generation,
          event,
          rawPayload,
          registrationTimeoutMs: Math.min(100, remainingMs),
          timeoutMs: remainingMs,
        }),
      );
      return writeResponse(response);
    } catch (error) {
      if (isNativeHookRelayDeadlineError(error)) {
        return timedOut(error);
      }
      if (isNativeHookRelayBridgeStaleRegistrationError(error)) {
        writeText(stderr, formatRelayCliError("native hook relay unavailable", error));
        return unavailable();
      }
      // Fall through to the gateway path for embedded/local gateway cases and
      // older registrations that predate the direct relay bridge.
    }

    try {
      const response = await withNativeHookRelayDeadline(
        deadline,
        callGatewayLazy<NativeHookRelayProcessResponse>({
          method: "nativeHook.invoke",
          params: { provider, relayId, generation, event, rawPayload },
          timeoutMs: remainingNativeHookRelayDeadlineMs(deadline),
          signal: deadline.signal,
          scopes: [ADMIN_SCOPE],
        }),
      );
      return writeResponse(response);
    } catch (error) {
      if (isNativeHookRelayDeadlineError(error)) {
        return timedOut(error);
      }
      writeText(stderr, formatRelayCliError("native hook relay unavailable", error));
      return unavailable();
    }
  } finally {
    deadline.dispose();
  }
}

async function callGatewayLazy<T = Record<string, unknown>>(opts: CallGatewayOptions): Promise<T> {
  const { callGateway } = await import("../gateway/call.js");
  return await callGateway<T>(opts);
}

function readRequiredOption(value: string | undefined, name: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new Error(`Missing required option --${name}`);
}

async function readStreamText(
  stream: typeof process.stdin,
  maxBytes: number,
  deadline: NativeHookRelayDeadline,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  const abortRead = () => {
    stream.destroy(new NativeHookRelayDeadlineError(deadline.timeoutMs));
  };
  deadline.signal.addEventListener("abort", abortRead, { once: true });
  try {
    remainingNativeHookRelayDeadlineMs(deadline);
    for await (const chunk of stream) {
      remainingNativeHookRelayDeadlineMs(deadline);
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxBytes) {
        throw new Error(`native hook input exceeds ${maxBytes} bytes`);
      }
      chunks.push(buffer);
    }
    remainingNativeHookRelayDeadlineMs(deadline);
    return Buffer.concat(chunks, total).toString("utf8");
  } catch (error) {
    if (isNativeHookRelayDeadlineError(error) || deadline.signal.aborted) {
      throw new NativeHookRelayDeadlineError(deadline.timeoutMs);
    }
    throw error;
  } finally {
    deadline.signal.removeEventListener("abort", abortRead);
  }
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

function createNativeHookRelayDeadline(timeoutMs: number) {
  const controller = new AbortController();
  const timer = setSafeTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return {
    expiresAtMs: performance.now() + timeoutMs,
    signal: controller.signal,
    timeoutMs,
    dispose: () => clearTimeout(timer),
  };
}

function isNativeHookRelayDeadlineError(error: unknown): error is NativeHookRelayDeadlineError {
  return error instanceof Error && error.name === "NativeHookRelayDeadlineError";
}

function remainingNativeHookRelayDeadlineMs(deadline: NativeHookRelayDeadline): number {
  const remainingMs = deadline.expiresAtMs - performance.now();
  if (remainingMs <= 0 || deadline.signal.aborted) {
    throw new NativeHookRelayDeadlineError(deadline.timeoutMs);
  }
  return Math.max(1, remainingMs);
}

async function withNativeHookRelayDeadline<T>(
  deadline: NativeHookRelayDeadline,
  promise: Promise<T>,
): Promise<T> {
  if (deadline.expiresAtMs <= performance.now()) {
    // Startup may spend the deadline before handing back its already-running promise.
    void promise.catch(() => undefined);
    throw new NativeHookRelayDeadlineError(deadline.timeoutMs);
  }
  return await racePromiseWithAbortSignal(
    promise.then(
      (value) => {
        // Promise reactions can run before an overdue timer after an event-loop stall.
        remainingNativeHookRelayDeadlineMs(deadline);
        return value;
      },
      (error: unknown) => {
        throw error instanceof Error ? error : new Error(String(error));
      },
    ),
    deadline.signal,
    () => new NativeHookRelayDeadlineError(deadline.timeoutMs),
  );
}
