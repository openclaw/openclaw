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
  it("selects the library before its single memoized probe and immutable publication", async () => {
    const pending = createDeferredCore<SqliteRuntimeCapabilities>();
    const order: string[] = [];
    const options = fixture({
      select: () => order.push("select"),
      probe: () => {
        order.push("probe");
        return pending.promise;
      },
    });
    const first = initializeSqliteRuntimeCapabilities(options);
    expect(initializeSqliteRuntimeCapabilities(options)).toBe(first);
    expect(order).toEqual(["select", "probe"]);
    expect(options.internals.publish).not.toHaveBeenCalled();
    pending.resolve({ ...positive });
    const decision = await first;
    expect(decision).toEqual(positive);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(options.internals.publish).toHaveBeenCalledExactlyOnceWith(decision);
    expect(getSqliteRuntimeCapabilities(options)).toBe(decision);
    expect(initializeSqliteRuntimeCapabilities(options)).toBe(first);
  });

  it("lets per-operation consumers observe a late decision without sealing early reads", async () => {
    const pending = createDeferredCore<SqliteRuntimeCapabilities>();
    const options = fixture({ probe: () => pending.promise });
    const initializing = initializeSqliteRuntimeCapabilities(options);
    const chosen = getSqliteRuntimeCapabilities(options);
    expect(chosen.explicitSqliteCloseReleasesNativeResources).toBe(false);
    expect(chosen.decided).toBe(false);
    expect(options.internals.publish).not.toHaveBeenCalled();
    pending.resolve({ ...positive });
    expect(await initializing).toEqual(positive);
    expect(getSqliteRuntimeCapabilities(options)).toEqual(positive);
    expect(chosen.explicitSqliteCloseReleasesNativeResources).toBe(false);
    expect(options.internals.publish).toHaveBeenCalledExactlyOnceWith(positive);
    expect(options.internals.warn).not.toHaveBeenCalled();
  });

  it("does not probe for short paths that only consume the conservative fact", () => {
    const options = fixture();
    const chosen = getSqliteRuntimeCapabilities(options);
    expect(getSqliteRuntimeCapabilities(options)).toBe(chosen);
    expect(chosen.decided).toBe(false);
    expect(options.internals.probe).not.toHaveBeenCalled();
    expect(options.internals.select).not.toHaveBeenCalled();
    expect(options.internals.publish).not.toHaveBeenCalled();
  });

  it("captures topology independently and records late capable admission once", async () => {
    const options = fixture();
    const early = captureSqliteWorkerClosePolicy(options);
    expect(captureSqliteWorkerClosePolicy(options)).toBe(false);
    expect(await initializeSqliteRuntimeCapabilities(options)).toEqual(positive);
    expect(early).toBe(false);
    expect(captureSqliteWorkerClosePolicy(options)).toBe(true);
    await initializeSqliteRuntimeCapabilities(options);
    expect(options.internals.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("2 topology owners"),
    );
  });

  it("keeps an early worker conservative for its lifetime after its parent's decision", async () => {
    const options = fixture({ isMainThread: false });
    const initial = getSqliteRuntimeCapabilities(options);
    options.internals.inherited = positive;
    expect(await initializeSqliteRuntimeCapabilities(options)).toBe(initial);
    expect(getSqliteRuntimeCapabilities(options)).toBe(initial);
    expect(initial.explicitSqliteCloseReleasesNativeResources).toBe(false);
    expect(options.internals.probe).not.toHaveBeenCalled();
  });

  it("can disable optimization for internal comparisons without running the probe", async () => {
    const options = fixture({ forceConservative: true });
    expect(await initializeSqliteRuntimeCapabilities(options)).toMatchObject({
      explicitSqliteCloseReleasesNativeResources: false,
      decided: true,
      reason: expect.stringContaining("diagnostic flag"),
    });
    expect(options.internals.probe).not.toHaveBeenCalled();
  });

  it.each(["win32", "darwin", "linux"])("admits Node without probing on %s", async (platform) => {
    const options = fixture({ isBun: false, platform });
    expect(await initializeSqliteRuntimeCapabilities(options)).toEqual({
      explicitSqliteCloseReleasesNativeResources: true,
      decided: true,
      reason: "Node runtime",
    });
    expect(options.internals.probe).not.toHaveBeenCalled();
  });

  it("keeps Bun Windows conservative without probing even with an inherited positive fact", async () => {
    const options = fixture({ platform: "win32", isMainThread: false, inherited: positive });
    expect(await initializeSqliteRuntimeCapabilities(options)).toMatchObject({
      explicitSqliteCloseReleasesNativeResources: false,
      reason: expect.stringContaining("Windows"),
    });
    expect(options.internals.probe).not.toHaveBeenCalled();
  });

  it.each(["SQLite close probe timed out", "WAL preconditions unavailable"])(
    "records a conservative result for %s",
    async (reason) => {
      const options = fixture({
        probe: async () => ({ explicitSqliteCloseReleasesNativeResources: false, reason }),
      });
      expect(await initializeSqliteRuntimeCapabilities(options)).toEqual({
        explicitSqliteCloseReleasesNativeResources: false,
        decided: true,
        reason,
      });
    },
  );

  it("records probe errors without rejecting runtime admission", async () => {
    const options = fixture({
      probe: async () => {
        throw new Error("fixture native failure");
      },
    });
    const decision = await initializeSqliteRuntimeCapabilities(options);
    expect(decision).toMatchObject({
      explicitSqliteCloseReleasesNativeResources: false,
      reason: expect.stringContaining("fixture native failure"),
    });
    expect(getSqliteRuntimeCapabilities(options)).toBe(decision);
  });

  it("keeps library-selection failures separate from optional close capability", async () => {
    const options = fixture({
      select: () => {
        throw new Error("invalid library");
      },
    });
    await expect(initializeSqliteRuntimeCapabilities(options)).rejects.toThrow("invalid library");
    expect(options.internals.probe).not.toHaveBeenCalled();
    expect(options.internals.publish).not.toHaveBeenCalled();
  });

  it("keeps workers with missing parent admission conservative", async () => {
    const options = fixture({ isMainThread: false });
    expect(await initializeSqliteRuntimeCapabilities(options)).toMatchObject({
      explicitSqliteCloseReleasesNativeResources: false,
      reason: expect.stringContaining("Parent"),
    });
    expect(options.internals.probe).not.toHaveBeenCalled();
  });
});
