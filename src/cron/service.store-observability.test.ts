import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { createCronStoreHarness, createNoopLogger } from "./service.test-harness.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({
  prefix: "openclaw-cron-store-observability-",
});

describe("cron service store observability", () => {
  beforeEach(() => {
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
  });

  it("warns when stat fails with a non-ENOENT error", async () => {
    const { storePath } = await makeStorePath();
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    const statSpy = vi.spyOn(fs.promises, "stat");
    const deniedError = new Error("permission denied") as NodeJS.ErrnoException;
    deniedError.code = "EACCES";
    statSpy.mockImplementationOnce(async () => {
      throw deniedError;
    });

    try {
      await cron.start();
    } finally {
      cron.stop();
      statSpy.mockRestore();
    }

    const storeStatWarn = noopLogger.warn.mock.calls.find(
      (call) => call[1] === "cron: failed to stat store file",
    );
    expect(storeStatWarn).toBeDefined();
    expect(storeStatWarn?.[0]).toEqual(
      expect.objectContaining({
        storePath,
        err: expect.stringContaining("permission denied"),
      }),
    );
  });
});
