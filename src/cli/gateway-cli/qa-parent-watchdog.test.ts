// Gateway QA parent watchdog tests cover parent-process watchdog shutdown behavior.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { installQaParentWatchdog } from "./qa-parent-watchdog.js";

const QA_PARENT_PID_ENV = "OPENCLAW_QA_PARENT_PID";
const QA_TEMP_ROOT_ENV = "OPENCLAW_QA_TEMP_ROOT";
const QA_STAGED_RUNTIME_ROOT_ENV = "OPENCLAW_QA_STAGED_RUNTIME_ROOT";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("installQaParentWatchdog", () => {
  it("does not install without a QA parent pid", () => {
    expect(installQaParentWatchdog({ env: {}, ownPid: 10 })).toBeNull();
    expect(installQaParentWatchdog({ env: { [QA_PARENT_PID_ENV]: "10" }, ownPid: 10 })).toBeNull();
    expect(
      installQaParentWatchdog({ env: { [QA_PARENT_PID_ENV]: "not-a-pid" }, ownPid: 10 }),
    ).toBeNull();
    expect(
      installQaParentWatchdog({ env: { [QA_PARENT_PID_ENV]: "0x10" }, ownPid: 10 }),
    ).toBeNull();
    expect(installQaParentWatchdog({ env: { [QA_PARENT_PID_ENV]: "1e3" }, ownPid: 10 })).toBeNull();
  });

  it("exits after parent death without deleting roots that descendants may still use", async () => {
    const fixtureRoot = tempDirs.make("qa-parent-watchdog-");
    const roots = ["openclaw-qa-suite-runtime", "openclaw-qa-suite-staged"].map((name) =>
      path.join(fixtureRoot, name),
    );
    for (const root of roots) {
      mkdirSync(root);
      writeFileSync(path.join(root, "sentinel"), "owned by the process tree");
    }
    let tick: () => void = () => {
      throw new Error("watchdog interval was not installed");
    };
    const timer = { unref: vi.fn() };
    const clearIntervalMock = vi.fn();
    const exited = createDeferredCore();
    const exit = vi.fn(() => exited.resolve());
    const logger = { warn: vi.fn() };
    const kill = vi.fn(() => {
      const error = new Error("missing") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });

    const handle = installQaParentWatchdog({
      clearInterval: clearIntervalMock,
      env: {
        [QA_PARENT_PID_ENV]: "12345",
        [QA_STAGED_RUNTIME_ROOT_ENV]: roots[1],
        [QA_TEMP_ROOT_ENV]: roots[0],
      },
      exit,
      kill,
      logger,
      ownPid: 10,
      setInterval: (callback) => {
        tick = callback;
        return timer;
      },
    });

    expect(handle?.parentPid).toBe(12345);
    expect(timer.unref).toHaveBeenCalledTimes(1);
    tick();
    expect(kill).toHaveBeenCalledWith(12345, 0);
    expect(logger.warn).toHaveBeenCalledWith(
      "QA gateway parent pid 12345 exited; shutting down orphaned QA gateway",
    );
    expect(clearIntervalMock).toHaveBeenCalledWith(timer);
    await exited.promise;
    expect(exit).toHaveBeenCalledWith(0);
    for (const root of roots) {
      expect(readFileSync(path.join(root, "sentinel"), "utf8")).toBe("owned by the process tree");
    }
    handle?.stop();
    tick();
    expect(clearIntervalMock).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
