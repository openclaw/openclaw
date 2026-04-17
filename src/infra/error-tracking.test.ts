import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLogger, resetLogger, setLoggerOverride } from "../logging/logger.js";
import {
  __test__,
  captureException,
  flushErrorTracking,
  initErrorTracking,
  isErrorTrackingEnabled,
} from "./error-tracking.js";

type CaptureExceptionCall = [unknown, { level?: string; extra?: Record<string, unknown> }?];
type CaptureMessageCall = [string, string?];

function createSdkStub() {
  const captureException = vi.fn<(err: unknown, ctx?: Record<string, unknown>) => void>();
  const captureMessage = vi.fn<(message: string, level?: string) => void>();
  const flush = vi.fn<(timeoutMs?: number) => Promise<boolean>>(async () => true);
  const init = vi.fn<(opts: Record<string, unknown>) => void>();
  return {
    init,
    captureException,
    captureMessage,
    flush,
    calls: {
      captureException: captureException.mock.calls as unknown as CaptureExceptionCall[],
      captureMessage: captureMessage.mock.calls as unknown as CaptureMessageCall[],
    },
  };
}

const ENV_KEYS = [
  "OPENCLAW_ERROR_TRACKING_DSN",
  "OPENCLAW_ERROR_TRACKING_ENVIRONMENT",
  "OPENCLAW_ERROR_TRACKING_RELEASE",
];

describe("error-tracking", () => {
  const savedEnv: Record<string, string | undefined> = {};
  let logDir = "";
  let logFile = "";

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-error-tracking-"));
    logFile = path.join(logDir, "openclaw.log");
    setLoggerOverride({ level: "trace", file: logFile });
    __test__.reset();
  });

  afterEach(() => {
    __test__.reset();
    setLoggerOverride(null);
    resetLogger();
    if (logDir) {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
    for (const key of ENV_KEYS) {
      const prev = savedEnv[key];
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
  });

  it("is a no-op and reports disabled when no DSN is configured", async () => {
    const enabled = await initErrorTracking();
    expect(enabled).toBe(false);
    expect(isErrorTrackingEnabled()).toBe(false);

    captureException(new Error("ignored"));
    await expect(flushErrorTracking(10)).resolves.toBe(true);
  });

  it("initializes the SDK once and reuses the result on subsequent calls", async () => {
    const sdk = createSdkStub();
    const enabled = await initErrorTracking({ dsn: "https://example/123", sdk });
    expect(enabled).toBe(true);
    expect(isErrorTrackingEnabled()).toBe(true);
    expect(sdk.init).toHaveBeenCalledTimes(1);

    const enabledAgain = await initErrorTracking({ dsn: "https://other/456", sdk });
    expect(enabledAgain).toBe(true);
    expect(sdk.init).toHaveBeenCalledTimes(1);
  });

  it("strips Sentry's process-level handlers via the integrations filter", async () => {
    const sdk = createSdkStub();
    await initErrorTracking({ dsn: "https://example/123", sdk });
    const opts = sdk.init.mock.calls[0]?.[0] as
      | { integrations?: (defaults: Array<{ name: string }>) => Array<{ name: string }> }
      | undefined;
    expect(typeof opts?.integrations).toBe("function");
    const filtered = opts?.integrations?.([
      { name: "OnUncaughtException" },
      { name: "OnUnhandledRejection" },
      { name: "Console" },
    ]);
    expect(filtered).toEqual([{ name: "Console" }]);
  });

  it("forwards logger.error records that contain an Error to captureException", async () => {
    const sdk = createSdkStub();
    await initErrorTracking({ dsn: "https://example/123", sdk });

    const boom = new Error("boom");
    getLogger().error("something failed", boom);

    expect(sdk.captureException).toHaveBeenCalledTimes(1);
    const [capturedErr, ctx] = sdk.calls.captureException[0] ?? [];
    expect(capturedErr).toBe(boom);
    expect(ctx?.level).toBe("error");
    expect(sdk.captureMessage).not.toHaveBeenCalled();
  });

  it("forwards logger.fatal records as fatal-level captures", async () => {
    const sdk = createSdkStub();
    await initErrorTracking({ dsn: "https://example/123", sdk });

    getLogger().fatal("the sky fell");

    expect(sdk.captureMessage).toHaveBeenCalledTimes(1);
    const [message, level] = sdk.calls.captureMessage[0] ?? [];
    expect(message).toContain("the sky fell");
    expect(level).toBe("fatal");
  });

  it("ignores logger records below error level", async () => {
    const sdk = createSdkStub();
    await initErrorTracking({ dsn: "https://example/123", sdk });

    getLogger().info("steady state");
    getLogger().warn("something odd");

    expect(sdk.captureException).not.toHaveBeenCalled();
    expect(sdk.captureMessage).not.toHaveBeenCalled();
  });

  it("captures non-Error reasons by wrapping them", async () => {
    const sdk = createSdkStub();
    await initErrorTracking({ dsn: "https://example/123", sdk });

    captureException("string reason", { classification: "fatal" });

    expect(sdk.captureException).toHaveBeenCalledTimes(1);
    const [err, ctx] = sdk.calls.captureException[0] ?? [];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("string reason");
    expect(ctx?.extra).toEqual({ classification: "fatal" });
  });

  it("flushErrorTracking forwards the timeout to the SDK and returns its result", async () => {
    const sdk = createSdkStub();
    sdk.flush.mockResolvedValueOnce(false);
    await initErrorTracking({ dsn: "https://example/123", sdk });

    await expect(flushErrorTracking(123)).resolves.toBe(false);
    expect(sdk.flush).toHaveBeenCalledWith(123);
  });

  it("swallows SDK errors so logging never breaks the host", async () => {
    const sdk = createSdkStub();
    sdk.captureException.mockImplementation(() => {
      throw new Error("sentry exploded");
    });
    sdk.captureMessage.mockImplementation(() => {
      throw new Error("sentry exploded again");
    });
    await initErrorTracking({ dsn: "https://example/123", sdk });

    expect(() => captureException(new Error("boom"))).not.toThrow();
    expect(() => getLogger().error("ouch")).not.toThrow();
  });
});
