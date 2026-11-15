import { afterEach, expect, it, vi } from "vitest";
import { setVerbose } from "../global-state.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { mockCall } from "../test-utils/mock-call-assertions.js";
import { runPluginHostCleanup } from "./host-hook-cleanup.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

afterEach(() => {
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
  vi.useRealTimers();
});

it.each(["reset", "delete"] as const)(
  "warns once per failed session %s cleanup and keeps successful cleanup quiet",
  async (reason) => {
    vi.useFakeTimers();
    setVerbose(false);
    setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle: "compact" });
    const warn = vi.fn();
    loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    const secret = "sk-cleanup-fixture-123456789012345678901234567890";
    const error = new Error(`cleanup failed token=${secret} ${"detail ".repeat(1000)}`);
    const cleanup = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const registry = createEmptyPluginRegistry();
    registry.runtimeLifecycles.push({
      pluginId: "cleanup-fixture",
      pluginName: "Cleanup Fixture",
      source: "test",
      lifecycle: { id: "release", cleanup },
    });
    const params = {
      registry,
      reason,
      sessionKey: "agent:main:cleanup-fixture",
      skipPersistentSessionState: true,
    };

    await expect(runPluginHostCleanup(params)).resolves.toEqual({
      cleanupCount: 0,
      failures: [{ pluginId: "cleanup-fixture", hookId: "runtime:release", error }],
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(mockCall(warn)[0]);
    expect(line).toContain(`session ${reason}`);
    expect(line).toContain("pluginId=cleanup-fixture");
    expect(line).toContain("hookId=runtime:release");
    expect(line).toContain("check the reported cleanup error and retry");
    expect(line).not.toContain(secret);
    expect(line).toContain("...(truncated)");
    expect(line.length).toBeLessThan(2300);

    warn.mockClear();
    await expect(runPluginHostCleanup(params)).resolves.toEqual({
      cleanupCount: 1,
      failures: [],
    });
    expect(warn).not.toHaveBeenCalled();
  },
);
