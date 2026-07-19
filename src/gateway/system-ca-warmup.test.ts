import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { warmMacOSSystemCaOffMainThread } from "./system-ca-warmup.js";

class FakeWorker extends EventEmitter {
  unref = vi.fn();
}

describe("warmMacOSSystemCaOffMainThread", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["env only", "darwin", { NODE_USE_SYSTEM_CA: "1" }, [], true],
    ["dash flag", "darwin", {}, ["--use-system-ca"], true],
    ["underscore flag", "darwin", {}, ["--use_system_ca"], true],
    ["equals-form flag", "darwin", {}, ["--use_system_ca=false"], true],
    ["OpenSSL CA alone", "darwin", {}, ["--use-openssl-ca"], false],
    [
      "bundled CA does not suppress env system CA",
      "darwin",
      { NODE_USE_SYSTEM_CA: "1" },
      ["--use-bundled-ca"],
      true,
    ],
    [
      "dash negation overrides env",
      "darwin",
      { NODE_USE_SYSTEM_CA: "1" },
      ["--no-use-system-ca"],
      false,
    ],
    [
      "equals-form negation overrides env",
      "darwin",
      { NODE_USE_SYSTEM_CA: "1" },
      ["--no-use-system-ca=false"],
      false,
    ],
    [
      "underscore negation overrides env",
      "darwin",
      { NODE_USE_SYSTEM_CA: "1" },
      ["--no_use_system_ca"],
      false,
    ],
    [
      "last conflicting flag enables",
      "darwin",
      {},
      ["--no-use-system-ca", "--use_system_ca"],
      true,
    ],
    [
      "last conflicting flag disables",
      "darwin",
      {},
      ["--use-system-ca", "--no_use_system_ca"],
      false,
    ],
    ["NODE_OPTIONS flag", "darwin", { NODE_OPTIONS: '"--use_system_ca"' }, [], true],
    [
      "NODE_OPTIONS negation overrides env",
      "darwin",
      { NODE_USE_SYSTEM_CA: "1", NODE_OPTIONS: "--no-use-system-ca" },
      [],
      false,
    ],
    [
      "execArgv overrides NODE_OPTIONS",
      "darwin",
      { NODE_OPTIONS: "--use-system-ca" },
      ["--no-use-system-ca"],
      false,
    ],
    ["system CA disabled", "darwin", { NODE_USE_SYSTEM_CA: "0" }, [], false],
    ["non-macOS", "linux", { NODE_USE_SYSTEM_CA: "1" }, [], false],
  ] as const)(
    "%s: warmup runs iff system CA is effectively enabled on macOS",
    async (_name, platform, env, execArgv, shouldWarm) => {
      const worker = new FakeWorker();
      const createWorker = vi.fn(() => worker);
      const warmup = warmMacOSSystemCaOffMainThread({
        platform,
        env: { ...env },
        execArgv: [...execArgv],
        createWorker,
      });

      if (shouldWarm) {
        worker.emit("message", { ok: true, certificateCount: 42 });
      }
      await warmup;
      expect(createWorker).toHaveBeenCalledTimes(shouldWarm ? 1 : 0);
      expect(worker.unref).toHaveBeenCalledTimes(shouldWarm ? 1 : 0);
    },
  );

  it("waits for the worker while leaving the main event loop available", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const log = { warn: vi.fn() };
    const warmup = warmMacOSSystemCaOffMainThread({
      platform: "darwin",
      env: { NODE_USE_SYSTEM_CA: "1" },
      warningMs: 10,
      log,
      createWorker: vi.fn(() => worker),
    });

    let mainTurnRan = false;
    setImmediate(() => {
      mainTurnRan = true;
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(mainTurnRan).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      "macOS system CA warmup is still waiting for Keychain trust settings; channel startup remains deferred",
    );
    expect(worker.unref).toHaveBeenCalledOnce();

    worker.emit("message", { ok: true, certificateCount: 42 });
    await warmup;
  });

  it("fails closed when the worker cannot populate the cache", async () => {
    const worker = new FakeWorker();
    const warmup = warmMacOSSystemCaOffMainThread({
      platform: "darwin",
      env: { NODE_USE_SYSTEM_CA: "1" },
      createWorker: vi.fn(() => worker),
    });

    worker.emit("message", { ok: false, error: "trust store unavailable" });

    await expect(warmup).rejects.toThrow("trust store unavailable");
  });
});
