import { once } from "node:events";
import type { Server } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { createSuiteLogPathTracker } from "../../logging/log-test-helpers.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { createDiagnosticLogRecordCapture } from "../../logging/test-helpers/diagnostic-log-capture.js";

export async function listenLoopback(server: Server) {
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP test address");
  }
  return address.port;
}

export function closeServer(server: Server) {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

export function setupDesktopDiagnostics(
  cleanup: Array<() => Promise<void>>,
  prefix: string,
  restoreBeforeCleanup = false,
) {
  const paths = createSuiteLogPathTracker(prefix);
  const captures: ReturnType<typeof createDiagnosticLogRecordCapture>[] = [];
  beforeAll(() => paths.setup());
  beforeEach(() =>
    setLoggerOverride({ level: "info", consoleLevel: "silent", file: paths.nextPath() }),
  );
  afterAll(() => paths.cleanup());
  afterEach(async () => {
    try {
      if (restoreBeforeCleanup) {
        vi.restoreAllMocks();
      }
      await Promise.all(cleanup.splice(0).map((run) => run()));
      await flushLogger();
      for (const capture of captures) {
        await capture.flush();
      }
      if (vi.isFakeTimers()) {
        expect(vi.getTimerCount()).toBe(0);
      }
    } finally {
      for (const capture of captures.splice(0)) {
        capture.cleanup();
      }
      resetLogger();
      if (!restoreBeforeCleanup) {
        vi.restoreAllMocks();
      }
      vi.useRealTimers();
    }
  });
  return () => {
    const capture = createDiagnosticLogRecordCapture();
    captures.push(capture);
    return capture;
  };
}
