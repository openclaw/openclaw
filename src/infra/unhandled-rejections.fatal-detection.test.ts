import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { registerSignalExitOwner, waitForCliSignalExit } from "../cli/signal-exit-barrier.js";

const restoreRuntimeTerminalStateMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime.js", () => ({ restoreRuntimeTerminalState: restoreRuntimeTerminalStateMock }));

import {
  installUnhandledRejectionHandler,
  isUncaughtExceptionHandled as isHandled,
  registerUncaughtExceptionHandler as onException,
  registerUnhandledRejectionHandler as onRejection,
} from "./unhandled-rejections.js";

let disposers: Array<() => void>;
let originalExitCode: typeof process.exitCode;
const mockExit = () => vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
let exitSpy: ReturnType<typeof mockExit>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let rejectionListener: (reason: unknown, promise: Promise<unknown>) => void;

beforeAll(() => {
  const index = process.listeners("unhandledRejection").length;
  installUnhandledRejectionHandler();
  rejectionListener = process.listeners("unhandledRejection")[index]!;
  expect(rejectionListener).toBeTypeOf("function");
});
beforeEach(() => {
  disposers = [];
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
  exitSpy = mockExit();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  for (const dispose of disposers) {
    dispose();
  }
  await waitForCliSignalExit();
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
afterAll(() => process.removeListener("unhandledRejection", rejectionListener));

const emitUnhandled = (reason: unknown) =>
  process.emit("unhandledRejection", reason, Promise.resolve());

it.each([
  ["ERR_OUT_OF_MEMORY", 1, "fatal unhandled rejection", "FATAL unhandled rejection:", false],
  ["INVALID_CONFIG", 78, "configuration error", "CONFIGURATION ERROR - requires fix:", false],
  ["MISSING_API_KEY", 1, "configuration error", "CONFIGURATION ERROR - requires fix:", false],
  [undefined, 1, "unhandled rejection", "Unhandled promise rejection:", false],
  ["ERR_WORKER_OUT_OF_MEMORY", 1, "fatal unhandled rejection", "FATAL unhandled rejection:", true],
  [undefined, 1, "unhandled rejection", "Unhandled promise rejection:", true],
] as const)("routes exit case %# (%s)", async (code, exitCode, reason, label, owned) => {
  const owner = vi.fn();
  if (owned) {
    disposers.push(registerSignalExitOwner(owner));
  }
  emitUnhandled(Object.assign(new Error("failure"), { code }));
  if (owned) {
    expect(owner).toHaveBeenCalledExactlyOnceWith(exitCode, reason);
    expect(process.exitCode).toBeUndefined();
  } else {
    expect(await waitForCliSignalExit()).toBe(exitCode);
    expect(process.exitCode).toBe(exitCode);
  }
  expect(exitSpy).not.toHaveBeenCalled();
  expect(restoreRuntimeTerminalStateMock).toHaveBeenCalledWith(reason, {
    resumeStdinIfPaused: false,
  });
  expect(errorSpy).toHaveBeenCalledWith(`[openclaw] ${label}`, expect.stringContaining("failure"));
  expect(warnSpy).not.toHaveBeenCalled();
});

const continuing = "Non-fatal unhandled rejection (continuing):";
const network = Object.assign(new TypeError("net"), {
  cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
});
it.each([
  [network, continuing],
  [Object.assign(new Error("sqlite"), { code: "SQLITE_CANTOPEN" }), continuing],
  [Object.assign(new Error("aborted"), { name: "AbortError" }), "Suppressed AbortError:"],
] as const)("warns without exiting for %s", (error, label) => {
  emitUnhandled(error);
  expect(exitSpy).not.toHaveBeenCalled();
  expect(restoreRuntimeTerminalStateMock).not.toHaveBeenCalled();
  expect(warnSpy).toHaveBeenCalledWith(
    `[openclaw] ${label}`,
    expect.stringContaining(error.message),
  );
  expect(errorSpy).not.toHaveBeenCalled();
});

it("shares registrations across module copies but separates exception handlers", async () => {
  vi.resetModules();
  const copy = await import("./unhandled-rejections.js");
  expect(copy.registerUnhandledRejectionHandler).not.toBe(onRejection);
  const error = new Error("registry input");
  const handler = vi.fn(() => true);
  const other = vi.fn(() => true);
  disposers.push(onRejection(handler));
  const duplicateDispose = copy.registerUnhandledRejectionHandler(handler);
  disposers.push(duplicateDispose);
  disposers.push(copy.registerUncaughtExceptionHandler(other));
  rejectionListener(error, Promise.resolve());
  expect(handler.mock.calls).toEqual([[error]]);
  expect(other).not.toHaveBeenCalled();
  expect(exitSpy).not.toHaveBeenCalled();
  duplicateDispose();
  rejectionListener(error, Promise.resolve());
  expect(handler).toHaveBeenCalledTimes(1);
  expect(other).not.toHaveBeenCalled();
  expect(await waitForCliSignalExit()).toBe(1);
  expect(process.exitCode).toBe(1);
  expect(exitSpy).not.toHaveBeenCalled();
});

it("continues past declining and throwing handlers, then stops at the first claim", () => {
  const error = new Error("registry input");
  const withoutStack = new Error("message fallback");
  delete withoutStack.stack;
  const thrown = [new Error("stack detail"), withoutStack, { detail: "non-Error" }];
  const calls: string[] = [];
  const add = (label: string, action: () => boolean) =>
    disposers.push(
      onRejection((value) => {
        expect(value).toBe(error);
        calls.push(label);
        return action();
      }),
    );
  add("false", () => false);
  for (const [index, failure] of thrown.entries()) {
    add(`throw-${index}`, () => {
      // oxlint-disable-next-line typescript/only-throw-error -- Exercise non-Error throws.
      throw failure;
    });
  }
  add("handled", () => true);
  add("unreached", () => true);
  rejectionListener(error, Promise.resolve());
  expect(calls).toEqual(["false", "throw-0", "throw-1", "throw-2", "handled"]);
  expect(errorSpy.mock.calls).toEqual(
    thrown.map((failure) => [
      "[openclaw] Unhandled rejection handler failed:",
      failure instanceof Error ? (failure.stack ?? failure.message) : failure,
    ]),
  );
  expect(exitSpy).not.toHaveBeenCalled();
});

it("unregisters scoped exception suppression", () => {
  const cleanup = onException((error) => error instanceof Error && error.message === "known");
  disposers.push(cleanup);
  expect(isHandled(new Error("known"))).toBe(true);
  expect(isHandled(new Error("unknown"))).toBe(false);
  cleanup();
  expect(isHandled(new Error("known"))).toBe(false);
});
