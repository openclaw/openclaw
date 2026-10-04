import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  captureSqliteWorkerClosePolicy,
  getSqliteRuntimeCapabilities,
  initializeSqliteRuntimeCapabilities,
  type SqliteRuntimeCapabilities,
} from "./bun-sqlite-library.js";

vi.mock("./bun-sqlite-close-probe.js", () => ({ probeSqliteNativeClose: vi.fn() }));

const positive = {
  explicitSqliteCloseReleasesNativeResources: true,
  decided: true,
  reason: "probe passed",
};
function fixture(
  overrides: Partial<
    NonNullable<Parameters<typeof initializeSqliteRuntimeCapabilities>[0]>["internals"]
  > = {},
) {
  return {
    internals: {
      isBun: true,
      platform: "linux",
      isMainThread: true,
      select: vi.fn(),
      probe: vi.fn(async () => positive),
      publish: vi.fn(),
      warn: vi.fn(),
      ...overrides,
    },
  };
}

describe("SQLite native-close admission", () => {
  it.each([false, true])("publishes one late decision (early topology: %s)", async (topology) => {
    const pending = createDeferredCore<SqliteRuntimeCapabilities>();
    const order: string[] = [];
    const options = fixture({
      select: vi.fn(() => order.push("select")),
      probe: vi.fn(() => {
        order.push("probe");
        return pending.promise;
      }),
    });
    const chosen = getSqliteRuntimeCapabilities(options);
    expect(getSqliteRuntimeCapabilities(options)).toBe(chosen);
    expect(chosen).toMatchObject({
      explicitSqliteCloseReleasesNativeResources: false,
      decided: false,
    });
    expect(options.internals.select).not.toHaveBeenCalled();
    expect(options.internals.probe).not.toHaveBeenCalled();
    expect(options.internals.publish).not.toHaveBeenCalled();
    const early = topology ? captureSqliteWorkerClosePolicy(options) : undefined;
    if (topology) {
      expect(captureSqliteWorkerClosePolicy(options)).toBe(false);
    }
    const first = initializeSqliteRuntimeCapabilities(options);
    expect(initializeSqliteRuntimeCapabilities(options)).toBe(first);
    expect(order).toEqual(["select", "probe"]);
    expect(getSqliteRuntimeCapabilities(options)).toBe(chosen);
    expect(options.internals.publish).not.toHaveBeenCalled();
    pending.resolve({ ...positive });
    const decision = await first;
    expect(decision).toEqual(positive);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(options.internals.publish).toHaveBeenCalledExactlyOnceWith(decision);
    expect(getSqliteRuntimeCapabilities(options)).toBe(decision);
    expect(initializeSqliteRuntimeCapabilities(options)).toBe(first);
    expect(chosen.explicitSqliteCloseReleasesNativeResources).toBe(false);
    expect(captureSqliteWorkerClosePolicy(options)).toBe(true);
    if (topology) {
      expect(early).toBe(false);
      expect(options.internals.warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("2 topology owners"),
      );
    } else {
      expect(options.internals.warn).not.toHaveBeenCalled();
    }
  });

  it("keeps a worker with missing parent admission conservative for its lifetime", async () => {
    const options = fixture({ isMainThread: false });
    const initial = getSqliteRuntimeCapabilities(options);
    expect(initial).toMatchObject({
      explicitSqliteCloseReleasesNativeResources: false,
      reason: expect.stringContaining("Parent"),
    });
    options.internals.inherited = positive;
    expect(await initializeSqliteRuntimeCapabilities(options)).toBe(initial);
    expect(getSqliteRuntimeCapabilities(options)).toBe(initial);
    expect(options.internals.probe).not.toHaveBeenCalled();
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
        await expect(initializeSqliteRuntimeCapabilities(options)).rejects.toThrow(reason);
        expect(options.internals.publish).not.toHaveBeenCalled();
      } else {
        const decision = await initializeSqliteRuntimeCapabilities(options);
        expect(decision).toEqual({
          explicitSqliteCloseReleasesNativeResources: capable,
          decided: true,
          reason:
            name === "Node" || name === "negative probe" ? reason : expect.stringContaining(reason),
        });
        expect(getSqliteRuntimeCapabilities(options)).toBe(decision);
      }
      expect(options.internals.probe).toHaveBeenCalledTimes(probes);
    },
  );
});
