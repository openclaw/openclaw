import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GATEWAY_LOG_ARCHIVES,
  DEFAULT_GATEWAY_LOG_MAX_BYTES,
  MAX_GATEWAY_LOG_ARCHIVES,
  applyGatewayLogRetention,
  resolveGatewayLogRetentionLimits,
  rotateOversizedDaemonLog,
  type DaemonLogRetentionFs,
} from "./log-retention.js";

function enoent(message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

function makeFs(initial: Map<string, number>): {
  fs: DaemonLogRetentionFs;
  files: Map<string, number>;
  renames: Array<[string, string]>;
  unlinks: string[];
} {
  const files = new Map(initial);
  const renames: Array<[string, string]> = [];
  const unlinks: string[] = [];
  const fs: DaemonLogRetentionFs = {
    stat: async (p) => {
      const size = files.get(p);
      if (size === undefined) {
        throw enoent(`stat ${p}`);
      }
      return { size };
    },
    rename: async (from, to) => {
      const size = files.get(from);
      if (size === undefined) {
        throw enoent(`rename ${from}`);
      }
      files.delete(from);
      files.set(to, size);
      renames.push([from, to]);
    },
    unlink: async (p) => {
      if (!files.has(p)) {
        throw enoent(`unlink ${p}`);
      }
      files.delete(p);
      unlinks.push(p);
    },
  };
  return { fs, files, renames, unlinks };
}

describe("resolveGatewayLogRetentionLimits", () => {
  it("returns defaults for an empty env", () => {
    expect(resolveGatewayLogRetentionLimits({})).toEqual({
      maxBytes: DEFAULT_GATEWAY_LOG_MAX_BYTES,
      archives: DEFAULT_GATEWAY_LOG_ARCHIVES,
    });
  });

  it("honors OPENCLAW_GATEWAY_LOG_MAX_BYTES", () => {
    expect(resolveGatewayLogRetentionLimits({ OPENCLAW_GATEWAY_LOG_MAX_BYTES: "1048576" })).toEqual(
      {
        maxBytes: 1048576,
        archives: DEFAULT_GATEWAY_LOG_ARCHIVES,
      },
    );
  });

  it("treats max=0 as a disable signal", () => {
    expect(resolveGatewayLogRetentionLimits({ OPENCLAW_GATEWAY_LOG_MAX_BYTES: "0" })).toEqual({
      maxBytes: 0,
      archives: DEFAULT_GATEWAY_LOG_ARCHIVES,
    });
  });

  it("ignores junk values and falls back to defaults", () => {
    expect(
      resolveGatewayLogRetentionLimits({
        OPENCLAW_GATEWAY_LOG_MAX_BYTES: "1.5MB",
        OPENCLAW_GATEWAY_LOG_ARCHIVES: "abc",
      }),
    ).toEqual({
      maxBytes: DEFAULT_GATEWAY_LOG_MAX_BYTES,
      archives: DEFAULT_GATEWAY_LOG_ARCHIVES,
    });
  });

  it("clamps archives to MAX_GATEWAY_LOG_ARCHIVES", () => {
    expect(
      resolveGatewayLogRetentionLimits({ OPENCLAW_GATEWAY_LOG_ARCHIVES: "999" }).archives,
    ).toBe(MAX_GATEWAY_LOG_ARCHIVES);
  });

  it("accepts archives=0 to drop oversize logs without keeping a backup", () => {
    expect(resolveGatewayLogRetentionLimits({ OPENCLAW_GATEWAY_LOG_ARCHIVES: "0" })).toEqual({
      maxBytes: DEFAULT_GATEWAY_LOG_MAX_BYTES,
      archives: 0,
    });
  });
});

describe("rotateOversizedDaemonLog", () => {
  const limits = { maxBytes: 1024, archives: 1 };

  it("is a no-op when the log file is missing", async () => {
    const { fs, renames, unlinks } = makeFs(new Map());
    const result = await rotateOversizedDaemonLog({ path: "/var/log/gateway.err.log", limits }, fs);
    expect(result).toEqual({ rotated: false, reason: "missing" });
    expect(renames).toEqual([]);
    expect(unlinks).toEqual([]);
  });

  it("is a no-op when the log file is at or below the cap", async () => {
    const { fs, renames, files } = makeFs(new Map([["/var/log/gateway.err.log", 1024]]));
    const result = await rotateOversizedDaemonLog({ path: "/var/log/gateway.err.log", limits }, fs);
    expect(result).toEqual({ rotated: false, reason: "below-cap", sizeBytes: 1024 });
    expect(renames).toEqual([]);
    expect(files.has("/var/log/gateway.err.log")).toBe(true);
  });

  it("rotates oversized logs to .1 and deletes any pre-existing archive", async () => {
    const { fs, renames, unlinks, files } = makeFs(
      new Map([
        ["/var/log/gateway.err.log", 19_000_000_000],
        ["/var/log/gateway.err.log.1", 4_000_000_000],
      ]),
    );
    const result = await rotateOversizedDaemonLog({ path: "/var/log/gateway.err.log", limits }, fs);
    expect(result).toEqual({
      rotated: true,
      archivedTo: "/var/log/gateway.err.log.1",
      sizeBytes: 19_000_000_000,
    });
    expect(unlinks).toEqual(["/var/log/gateway.err.log.1"]);
    expect(renames).toEqual([["/var/log/gateway.err.log", "/var/log/gateway.err.log.1"]]);
    expect(files.has("/var/log/gateway.err.log")).toBe(false);
    expect(files.get("/var/log/gateway.err.log.1")).toBe(19_000_000_000);
  });

  it("cascades older archives when archives>1", async () => {
    const { fs, renames, files } = makeFs(
      new Map([
        ["/var/log/g.log", 5_000],
        ["/var/log/g.log.1", 4_000],
        ["/var/log/g.log.2", 3_000],
      ]),
    );
    const result = await rotateOversizedDaemonLog(
      { path: "/var/log/g.log", limits: { maxBytes: 1024, archives: 3 } },
      fs,
    );
    expect(result.rotated).toBe(true);
    expect(renames).toEqual([
      ["/var/log/g.log.2", "/var/log/g.log.3"],
      ["/var/log/g.log.1", "/var/log/g.log.2"],
      ["/var/log/g.log", "/var/log/g.log.1"],
    ]);
    expect(files.get("/var/log/g.log.1")).toBe(5_000);
    expect(files.get("/var/log/g.log.2")).toBe(4_000);
    expect(files.get("/var/log/g.log.3")).toBe(3_000);
    expect(files.has("/var/log/g.log")).toBe(false);
  });

  it("drops oversize logs without an archive when archives=0", async () => {
    const { fs, renames, unlinks, files } = makeFs(new Map([["/var/log/gateway.err.log", 5_000]]));
    const result = await rotateOversizedDaemonLog(
      { path: "/var/log/gateway.err.log", limits: { maxBytes: 1024, archives: 0 } },
      fs,
    );
    expect(result).toEqual({ rotated: true, archivedTo: "", sizeBytes: 5_000 });
    expect(renames).toEqual([]);
    expect(unlinks).toEqual(["/var/log/gateway.err.log"]);
    expect(files.has("/var/log/gateway.err.log")).toBe(false);
  });

  it("treats maxBytes=0 as disabled even for huge files", async () => {
    const { fs, renames, unlinks, files } = makeFs(
      new Map([["/var/log/gateway.err.log", 19_000_000_000]]),
    );
    const result = await rotateOversizedDaemonLog(
      { path: "/var/log/gateway.err.log", limits: { maxBytes: 0, archives: 1 } },
      fs,
    );
    expect(result).toEqual({ rotated: false, reason: "disabled" });
    expect(renames).toEqual([]);
    expect(unlinks).toEqual([]);
    expect(files.get("/var/log/gateway.err.log")).toBe(19_000_000_000);
  });

  it("does not throw when the pre-existing archive was already gone", async () => {
    const { fs, renames, unlinks } = makeFs(new Map([["/var/log/g.log", 5_000]]));
    const result = await rotateOversizedDaemonLog(
      { path: "/var/log/g.log", limits: { maxBytes: 1024, archives: 1 } },
      fs,
    );
    expect(result.rotated).toBe(true);
    expect(unlinks).toEqual([]);
    expect(renames).toEqual([["/var/log/g.log", "/var/log/g.log.1"]]);
  });

  it("propagates non-ENOENT stat errors", async () => {
    const fs: DaemonLogRetentionFs = {
      stat: vi.fn(async () => {
        const err = new Error("EACCES") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }),
      rename: vi.fn(),
      unlink: vi.fn(),
    };
    await expect(rotateOversizedDaemonLog({ path: "/var/log/g.log", limits }, fs)).rejects.toThrow(
      "EACCES",
    );
  });
});

describe("applyGatewayLogRetention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rotates both stdout and stderr sinks for the resolved log paths", async () => {
    const env = { HOME: "/Users/test", OPENCLAW_GATEWAY_LOG_MAX_BYTES: "1024" };
    const { fs, files } = makeFs(
      new Map([
        ["/Users/test/.openclaw/logs/gateway.log", 5_000],
        ["/Users/test/.openclaw/logs/gateway.err.log", 19_000_000_000],
      ]),
    );
    const result = await applyGatewayLogRetention(env, fs);
    expect(result.stdout.rotated).toBe(true);
    expect(result.stderr.rotated).toBe(true);
    expect(result.limits.maxBytes).toBe(1024);
    expect(files.get("/Users/test/.openclaw/logs/gateway.log.1")).toBe(5_000);
    expect(files.get("/Users/test/.openclaw/logs/gateway.err.log.1")).toBe(19_000_000_000);
  });

  it("is a no-op when both sinks are missing", async () => {
    const env = { HOME: "/Users/test" };
    const { fs } = makeFs(new Map());
    const result = await applyGatewayLogRetention(env, fs);
    expect(result.stdout).toEqual({ rotated: false, reason: "missing" });
    expect(result.stderr).toEqual({ rotated: false, reason: "missing" });
  });

  it("respects OPENCLAW_PROFILE when resolving paths", async () => {
    const env = {
      HOME: "/Users/test",
      OPENCLAW_PROFILE: "work",
      OPENCLAW_GATEWAY_LOG_MAX_BYTES: "1024",
    };
    const { fs, files } = makeFs(
      new Map([["/Users/test/.openclaw-work/logs/gateway.err.log", 5_000]]),
    );
    const result = await applyGatewayLogRetention(env, fs);
    expect(result.stderr.rotated).toBe(true);
    expect(files.get("/Users/test/.openclaw-work/logs/gateway.err.log.1")).toBe(5_000);
  });
});
