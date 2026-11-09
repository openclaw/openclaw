import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { GatewayServer } from "../../gateway/server-public.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { runLoopFixture } from "./run-loop-mocks.test-support.js";
import {
  createRuntimeWithExitSignal,
  createSignaledStart,
  waitForStart,
  waitForLoopCondition,
  withIsolatedSignals,
} from "./run-loop.test-support.js";

type GatewayCloseFn = GatewayServer["close"];

/** Register against collection-time mocks, never a reset registry module instance. */
export function registerGatewayLogSettlementTests({
  closeLogTempDirs,
  gatewayLog,
  flushLogger,
  runLoopWithStart,
}: Pick<
  typeof runLoopFixture,
  "closeLogTempDirs" | "gatewayLog" | "flushLogger" | "runLoopWithStart"
>) {
  it("persists an issued close-error log append before forced exit", async () => {
    const logger =
      await vi.importActual<typeof import("../../logging/logger.js")>("../../logging/logger.js");
    const { default: fsPromises } = await vi.importActual<{
      default: typeof import("node:fs/promises");
    }>("node:fs/promises");
    const logFile = join(closeLogTempDirs.make("openclaw-close-log-"), "gateway.jsonl");
    const appendAllowed = createDeferredCore();
    logger.setLoggerOverride({ level: "info", file: logFile });
    const fileLogger = logger.getChildLogger({ subsystem: "gateway" });
    const openFile = fsPromises.open.bind(fsPromises);
    const open = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      if (args[0] === logFile) {
        await appendAllowed.promise;
      }
      return openFile(...args);
    });
    gatewayLog.error.mockImplementation((message: string) => {
      fileLogger.error(message);
      void logger.flushLogger();
    });
    flushLogger.mockImplementation(() => logger.flushLogger());
    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const close = vi.fn<GatewayCloseFn>(() => {
          throw new TypeError("close owner failed");
        });
        const { start, started } = createSignaledStart(close);
        const { runtime, exited } = createRuntimeWithExitSignal();
        const exit = runtime.exit.getMockImplementation();
        let persistedAtExit = "";
        runtime.exit.mockImplementation((code) => {
          persistedAtExit = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
          exit?.(code);
        });
        await runLoopWithStart({ start, runtime });
        await waitForStart(started);
        captureSignal("SIGUSR2")();
        await waitForLoopCondition(
          () => runtime.exit.mock.calls.length > 0 || flushLogger.mock.calls.length > 0,
          "close failure did not reach exit or log flush",
        );
        appendAllowed.resolve();
        await expect(exited).resolves.toBe(1);
        expect(persistedAtExit).toContain(
          "shutdown step failed (gateway server close): close owner failed",
        );
      });
    } finally {
      appendAllowed.resolve();
      await logger.flushLogger();
      open.mockRestore();
      logger.resetLogger();
      gatewayLog.error.mockReset();
      flushLogger.mockReset().mockResolvedValue(undefined);
    }
  });
}
