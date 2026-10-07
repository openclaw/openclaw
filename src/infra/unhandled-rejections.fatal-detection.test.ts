import process from "node:process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const restoreRuntimeTerminalStateMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime.js", () => ({
  restoreRuntimeTerminalState: restoreRuntimeTerminalStateMock,
}));

import {
  installUnhandledRejectionHandler,
  isUncaughtExceptionHandled,
  registerUncaughtExceptionHandler,
  registerUnhandledRejectionHandler,
} from "./unhandled-rejections.js";

describe("process error handlers", () => {
  let exitCalls: Array<string | number | null>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let rejectionListener: (reason: unknown, promise: Promise<unknown>) => void;

  beforeAll(() => {
    const listeners = new Set(process.listeners("unhandledRejection"));
    installUnhandledRejectionHandler();
    const installed = process
      .listeners("unhandledRejection")
      .find((entry) => !listeners.has(entry));
    if (!installed) {
      throw new Error("Expected the installed unhandled rejection listener");
    }
    rejectionListener = installed;
  });
  beforeEach(() => {
    exitCalls = [];
    vi.spyOn(process, "exit").mockImplementation((code?: string | number | null): never => {
      if (code !== undefined && code !== null) {
        exitCalls.push(code);
      }
      return undefined as never;
    });
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });
  afterAll(() => process.removeListener("unhandledRejection", rejectionListener));

  const emitUnhandled = (reason: unknown) => {
    process.emit("unhandledRejection", reason, Promise.resolve());
  };

  it.each([
    ["ERR_OUT_OF_MEMORY", 1, "fatal unhandled rejection", "FATAL unhandled rejection:"],
    ["INVALID_CONFIG", 78, "configuration error", "CONFIGURATION ERROR - requires fix:"],
    ["MISSING_API_KEY", 1, "configuration error", "CONFIGURATION ERROR - requires fix:"],
  ] as const)("restores the terminal and exits for code %s", (code, exitCode, reason, label) => {
    emitUnhandled(Object.assign(new Error("expected failure"), { code }));
    expect(exitCalls).toEqual([exitCode]);
    expect(restoreRuntimeTerminalStateMock).toHaveBeenCalledWith(reason, {
      resumeStdinIfPaused: false,
    });
    expect(errorSpy).toHaveBeenCalledWith(
      `[openclaw] ${label}`,
      expect.stringContaining("expected failure"),
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each([Object.assign(new Error("unable to open database file"), { code: "SQLITE_CANTOPEN" })])(
    "warns without exiting for transient rejection %#",
    (error) => {
      emitUnhandled(error);
      expect(exitCalls).toEqual([]);
      expect(restoreRuntimeTerminalStateMock).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        "[openclaw] Non-fatal unhandled rejection (continuing):",
        expect.stringContaining(error.message),
      );
      expect(errorSpy).not.toHaveBeenCalled();
    },
  );

  it("suppresses cancellation without exiting", () => {
    emitUnhandled(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
    expect(exitCalls).toEqual([]);
    expect(restoreRuntimeTerminalStateMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "[openclaw] Suppressed AbortError:",
      expect.stringContaining("This operation was aborted"),
    );
  });

  it("shares registrations across module copies but separates exception handlers", async () => {
    vi.resetModules();
    const copy = await import("./unhandled-rejections.js");
    expect(copy.registerUnhandledRejectionHandler).not.toBe(registerUnhandledRejectionHandler);
    const error = new Error("registry input");
    const handler = vi.fn(() => true);
    const other = vi.fn(() => true);
    const dispose = registerUnhandledRejectionHandler(handler);
    const duplicateDispose = copy.registerUnhandledRejectionHandler(handler);
    const otherDispose = copy.registerUncaughtExceptionHandler(other);
    try {
      rejectionListener(error, Promise.resolve());
      expect(handler.mock.calls).toEqual([[error]]);
      expect(other).not.toHaveBeenCalled();
      expect(exitCalls).toEqual([]);
      duplicateDispose();
      rejectionListener(error, Promise.resolve());
      expect(handler).toHaveBeenCalledTimes(1);
      expect(other).not.toHaveBeenCalled();
      expect(exitCalls).toEqual([1]);
    } finally {
      dispose();
      duplicateDispose();
      otherDispose();
    }
  });

  it("continues past declining and throwing handlers, then stops at the first claim", () => {
    const error = new Error("registry input");
    const withoutStack = new Error("message fallback");
    delete withoutStack.stack;
    const thrown = [new Error("stack detail"), withoutStack, { detail: "non-Error" }];
    const calls: string[] = [];
    const disposers = [
      registerUnhandledRejectionHandler((value) => {
        expect(value).toBe(error);
        calls.push("false");
        return false;
      }),
    ];
    try {
      for (const [index, failure] of thrown.entries()) {
        disposers.push(
          registerUnhandledRejectionHandler((value) => {
            expect(value).toBe(error);
            calls.push(`throw-${index}`);
            // oxlint-disable-next-line typescript/only-throw-error -- Exercise non-Error throws from registered handlers.
            throw failure;
          }),
        );
      }
      disposers.push(
        registerUnhandledRejectionHandler((value) => {
          expect(value).toBe(error);
          calls.push("handled");
          return true;
        }),
      );
      disposers.push(
        registerUnhandledRejectionHandler(() => {
          calls.push("unreached");
          return true;
        }),
      );
      rejectionListener(error, Promise.resolve());
      expect(calls).toEqual(["false", "throw-0", "throw-1", "throw-2", "handled"]);
      expect(errorSpy.mock.calls).toEqual(
        thrown.map((failure) => [
          "[openclaw] Unhandled rejection handler failed:",
          failure instanceof Error ? (failure.stack ?? failure.message) : failure,
        ]),
      );
      expect(exitCalls).toEqual([]);
    } finally {
      for (const dispose of disposers) {
        dispose();
      }
    }
  });

  it("unregisters scoped exception suppression", () => {
    const cleanup = registerUncaughtExceptionHandler(
      (error) => error instanceof Error && error.message === "known dependency assertion",
    );
    try {
      expect(isUncaughtExceptionHandled(new Error("known dependency assertion"))).toBe(true);
      expect(isUncaughtExceptionHandled(new Error("unknown"))).toBe(false);
    } finally {
      cleanup();
    }
    expect(isUncaughtExceptionHandled(new Error("known dependency assertion"))).toBe(false);
  });
});
