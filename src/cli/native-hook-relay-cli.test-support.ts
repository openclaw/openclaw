import { vi } from "vitest";
import * as bridge from "../agents/harness/native-hook-relay-client.js";
import {
  runNativeHookRelayCli,
  runNativeHookRelayCliFromArgv,
  type NativeHookRelayCliOptions,
} from "./native-hook-relay-cli.js";

type NativeHookRelayCliTestDeps = {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  invokeBridge?: typeof bridge.invokeNativeHookRelayBridge;
  callGateway?: typeof import("../gateway/call.js").callGateway;
  /** How long the simulated hook process has been running when the relay starts. */
  processAgeMs?: number;
};

async function withRelayTestDeps(
  deps: NativeHookRelayCliTestDeps,
  run: () => Promise<number>,
): Promise<number> {
  const restore: Array<() => void> = [];
  try {
    // The relay deadline counts from process start (the performance.now() origin),
    // and the test runner is not a fresh hook process: move the origin to the call.
    // Wrap whatever clock the test installed (fake timers or its own spy).
    const clock = Object.getOwnPropertyDescriptor(performance, "now");
    const now = performance.now.bind(performance);
    const origin = now() - (deps.processAgeMs ?? 0);
    Object.defineProperty(performance, "now", { configurable: true, value: () => now() - origin });
    restore.push(() => {
      if (clock) {
        Object.defineProperty(performance, "now", clock);
      } else {
        Reflect.deleteProperty(performance, "now");
      }
    });
    if (deps.invokeBridge) {
      const spy = vi
        .spyOn(bridge, "invokeNativeHookRelayBridge")
        .mockImplementation(deps.invokeBridge);
      restore.push(() => spy.mockRestore());
    }
    if (deps.callGateway) {
      const gateway = await import("../gateway/call.js");
      const spy = vi.spyOn(gateway, "callGateway").mockImplementation(deps.callGateway);
      restore.push(() => spy.mockRestore());
    }
    for (const key of ["stdin", "stdout", "stderr"] as const) {
      const stream = deps[key];
      if (stream) {
        const descriptor = Object.getOwnPropertyDescriptor(process, key);
        if (!descriptor) {
          throw new Error(`Missing process.${key} descriptor`);
        }
        Object.defineProperty(process, key, { configurable: true, get: () => stream });
        restore.push(() => Object.defineProperty(process, key, descriptor));
      }
    }
    return await run();
  } finally {
    for (const cleanup of restore.toReversed()) {
      cleanup();
    }
  }
}

export function runNativeHookRelayCliForTest(
  options: NativeHookRelayCliOptions,
  deps: NativeHookRelayCliTestDeps,
): Promise<number> {
  return withRelayTestDeps(deps, () => runNativeHookRelayCli(options));
}

export function runNativeHookRelayCliFromArgvForTest(
  argv: string[],
  deps: NativeHookRelayCliTestDeps,
): Promise<number> {
  return withRelayTestDeps(deps, () => runNativeHookRelayCliFromArgv(argv));
}
