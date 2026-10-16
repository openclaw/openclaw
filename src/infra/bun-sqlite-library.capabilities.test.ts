import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import type { SqliteRuntimeCapabilities } from "./bun-sqlite-library.js";
import {
  captureSqliteWorkerClosePolicy,
  getSqliteRuntimeCapabilities,
  initializeSqliteRuntimeCapabilities,
  mockBunSqliteNativeBoundary,
  sqliteCapabilitiesKey,
  sqliteSelectionKey,
} from "./bun-sqlite-library.test-support.js";

const positive = {
  explicitSqliteCloseReleasesNativeResources: true,
  decided: true,
  reason: "probe passed",
};
function fixture(
  overrides: {
    isBun?: boolean;
    platform?: string;
    isMainThread?: boolean;
    inherited?: SqliteRuntimeCapabilities;
    forceConservative?: boolean;
    select?: () => unknown;
    probe?: () => Promise<SqliteRuntimeCapabilities>;
  } = {},
) {
  const native = mockBunSqliteNativeBoundary({
    isBun: overrides.isBun,
    isMainThread: overrides.isMainThread,
    platform: overrides.platform ?? "linux",
    env: overrides.forceConservative ? { OPENCLAW_DIAGNOSTICS: "sqlite.close.conservative" } : {},
  });
  native.environment.set(sqliteCapabilitiesKey, overrides.inherited);
  const select = vi.fn(overrides.select ?? (() => ({ source: "runtime" })));
  Object.defineProperty(globalThis, sqliteSelectionKey, { configurable: true, value: select });
  native.closeProbe.mockImplementation(overrides.probe ?? (async () => positive));
  return {
    select,
    probe: native.closeProbe,
    publish: native.publish,
    warn: vi.spyOn(process, "emitWarning").mockImplementation(() => {}),
    inherit: (value: SqliteRuntimeCapabilities) =>
      native.environment.set(sqliteCapabilitiesKey, value),
  };
}

describe("SQLite native-close admission", () => {
  it.each([false, true])("publishes one late decision (early topology: %s)", async (topology) => {
    const pending = createDeferredCore<SqliteRuntimeCapabilities>();
    const probeStarted = createDeferredCore();
    const order: string[] = [];
    const options = fixture({
      select: vi.fn(() => order.push("select")),
      probe: vi.fn(() => {
        order.push("probe");
        probeStarted.resolve();
        return pending.promise;
      }),
    });
    const chosen = getSqliteRuntimeCapabilities();
    expect(getSqliteRuntimeCapabilities()).toBe(chosen);
    expect(chosen).toMatchObject({
      explicitSqliteCloseReleasesNativeResources: false,
      decided: false,
    });
    expect(options.select).not.toHaveBeenCalled();
    expect(options.probe).not.toHaveBeenCalled();
    expect(options.publish).not.toHaveBeenCalled();
    const early = topology ? captureSqliteWorkerClosePolicy() : undefined;
    if (topology) {
      expect(captureSqliteWorkerClosePolicy()).toBe(false);
    }
    const first = initializeSqliteRuntimeCapabilities();
    expect(initializeSqliteRuntimeCapabilities()).toBe(first);
    await probeStarted.promise;
    expect(order).toEqual(["select", "probe"]);
    expect(getSqliteRuntimeCapabilities()).toBe(chosen);
    expect(options.publish).not.toHaveBeenCalled();
    pending.resolve({ ...positive });
    const decision = await first;
    expect(decision).toEqual(positive);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(options.publish).toHaveBeenCalledExactlyOnceWith(sqliteCapabilitiesKey, decision);
    expect(getSqliteRuntimeCapabilities()).toBe(decision);
    expect(initializeSqliteRuntimeCapabilities()).toBe(first);
    expect(chosen.explicitSqliteCloseReleasesNativeResources).toBe(false);
    expect(captureSqliteWorkerClosePolicy()).toBe(true);
    if (topology) {
      expect(early).toBe(false);
      expect(options.warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("2 topology owners"),
        { code: "SQLITE_EARLY_TOPOLOGY" },
      );
    } else {
      expect(options.warn).not.toHaveBeenCalled();
    }
  });

  it("keeps a worker with missing parent admission conservative for its lifetime", async () => {
    const options = fixture({ isMainThread: false });
    const initial = getSqliteRuntimeCapabilities();
    expect(initial).toMatchObject({
      explicitSqliteCloseReleasesNativeResources: false,
      reason: expect.stringContaining("Parent"),
    });
    options.inherit(positive);
    expect(await initializeSqliteRuntimeCapabilities()).toBe(initial);
    expect(getSqliteRuntimeCapabilities()).toBe(initial);
    expect(options.probe).not.toHaveBeenCalled();
  });

  it.each([
    ["diagnostic override", { forceConservative: true }, false, "diagnostic flag", 0],
    ["Node", { isBun: false, platform: "win32" }, true, "Node runtime", 0],
    [
      "Bun Windows",
      { platform: "win32", isMainThread: false, inherited: positive },
      false,
      "Windows",
      0,
    ],
    ["negative probe", {}, false, "WAL preconditions unavailable", 1],
    ["probe error", {}, false, "fixture native failure", 1],
    ["selection error", {}, false, "invalid library", 0],
  ] as const)(
    "handles %s at runtime admission",
    async (name, overrides, capable, reason, probes) => {
      const select = vi.fn();
      const probe = vi.fn(async () => positive);
      const options = fixture({ ...overrides, select, probe });
      if (name === "selection error") {
        select.mockImplementation(() => {
          throw new Error(reason);
        });
      } else if (name === "probe error") {
        probe.mockRejectedValue(new Error(reason));
      } else if (name === "negative probe") {
        probe.mockResolvedValue({
          ...positive,
          explicitSqliteCloseReleasesNativeResources: false,
          reason,
        });
      }
      if (name === "selection error") {
        await expect(initializeSqliteRuntimeCapabilities()).rejects.toThrow(reason);
        expect(options.publish).not.toHaveBeenCalled();
      } else {
        const decision = await initializeSqliteRuntimeCapabilities();
        expect(decision).toEqual({
          explicitSqliteCloseReleasesNativeResources: capable,
          decided: true,
          reason:
            name === "Node" || name === "negative probe" ? reason : expect.stringContaining(reason),
        });
        expect(getSqliteRuntimeCapabilities()).toBe(decision);
      }
      expect(options.probe).toHaveBeenCalledTimes(probes);
    },
  );
});
