// Covers runtime detection and version support checks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertSupportedRuntime,
  isSupportedBunVersion,
  isSupportedNodeVersion,
  nodeVersionSatisfiesEngine,
  parseSemver,
} from "./runtime-guard.js";

const state = vi.hoisted(() => ({
  version: "24.16.0",
  error: vi.fn(),
  run: vi.fn(),
  diagnosticLoads: 0,
  lossless: true,
}));

vi.mock("../../node-sqlite.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../node-sqlite.mjs")>();
  return {
    ...actual,
    detectCurrentSqliteCapabilities: () => ({
      ...actual.detectCurrentSqliteCapabilities(),
      text: state.lossless,
    }),
  };
});
vi.mock("node:process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:process")>();
  return {
    default: {
      ...actual,
      get versions() {
        return { ...actual.versions, node: state.version, bun: undefined };
      },
      stderr: { write: state.error },
      exit: (code: number) => {
        throw new Error(`runtime exit ${code}`);
      },
    },
  };
});
vi.mock("../logging/json-console-line.js", async (importOriginal) => {
  state.diagnosticLoads += 1;
  return await importOriginal<typeof import("../logging/json-console-line.js")>();
});
vi.mock("../worker/worker-deploy-runtime.js", () => ({}));
vi.mock("../worker/worker-deploy-browser-runtime.js", () => ({ default: {} }));
vi.mock("../worker/worker-process.js", () => ({ runWorkerProcess: state.run }));

describe("runtime-guard", () => {
  it.each([
    ["24.16.0", true, true],
    ["24.16.0", false, false],
    ["24.15.0+vendor.1", true, true],
    ["24.15.0+vendor.1", false, false],
  ] as const)("gates Node %s with lossless SQLite %s", async (version, lossless, admitted) => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const details = {
      kind: "node" as const,
      version,
      execPath: "/usr/bin/node",
      pathEnv: "/usr/bin",
      hasNodeSqlite: true,
      sqliteVersion: "3.51.3",
      sqliteProbe: { available: true, version: "3.51.3", text: lossless, blob: true, json: true },
    };
    await assertSupportedRuntime(runtime, details);
    expect(runtime.exit).toHaveBeenCalledTimes(admitted ? 0 : 1);
    if (!admitted) {
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("nodejs/node#61954"));
    }
  });

  it("keeps healthy runtime checks independent of diagnostic formatting", async () => {
    await assertSupportedRuntime();
    expect(state.diagnosticLoads).toBe(0);
    expect(state.error).not.toHaveBeenCalled();
  });

  it("parses semver with or without leading v", () => {
    expect(parseSemver("v22.1.3")).toEqual({ major: 22, minor: 1, patch: 3 });
    expect(parseSemver("1.3.0")).toEqual({ major: 1, minor: 3, patch: 0 });
    expect(parseSemver("22.22.3-beta.1")).toEqual({ major: 22, minor: 22, patch: 3 });
    expect(parseSemver("invalid")).toBeNull();
  });

  it("checks node versions against simple engine ranges", () => {
    expect(nodeVersionSatisfiesEngine("22.22.3", ">=22.22.3")).toBe(true);
    expect(nodeVersionSatisfiesEngine("22.22.2", ">=22.22.3")).toBe(false);
    expect(nodeVersionSatisfiesEngine("24.15.0", ">=22.22.3")).toBe(true);
    expect(nodeVersionSatisfiesEngine("22.22.3", "^22.22.3")).toBeNull();
  });

  it("preserves the target package's numeric engine range", () => {
    const engine = ">=24.16.0 <25 || >=26.1.0";
    expect(nodeVersionSatisfiesEngine("22.23.2", engine)).toBe(false);
    expect(nodeVersionSatisfiesEngine("22.22.2", engine)).toBe(false);
    expect(nodeVersionSatisfiesEngine("23.11.0", engine)).toBe(false);
    expect(nodeVersionSatisfiesEngine("24.14.1", engine)).toBe(false);
    expect(nodeVersionSatisfiesEngine("24.15.0+vendor.1", engine)).toBe(false);
    expect(nodeVersionSatisfiesEngine("24.16.0", engine)).toBe(true);
    expect(nodeVersionSatisfiesEngine("25.8.1", engine)).toBe(false);
    expect(nodeVersionSatisfiesEngine("25.9.0", engine)).toBe(false);
    expect(nodeVersionSatisfiesEngine("26.0.0", engine)).toBe(false);
    expect(nodeVersionSatisfiesEngine("26.1.0", engine)).toBe(true);
    expect(nodeVersionSatisfiesEngine(null, engine)).toBe(false);
    expect(nodeVersionSatisfiesEngine("unknown", engine)).toBe(false);
  });

  it.each([
    ["22.23.2", false],
    ["22.22.2", false],
    ["23.11.0", false],
    ["24.14.1", false],
    ["24.15.0", false],
    ["24.16.0", true],
    ["25.8.1", false],
    ["25.9.0", false],
    ["26.0.0", false],
    ["26.1.0", true],
    ["24.16.0+local.1", true],
    ["24.15.0-rc.1", false],
    ["25.9.1-nightly.20260714", false],
    ["24.15", false],
    ["garbage24.15.0suffix", false],
    ["24.15.0suffix", false],
    [null, false],
  ] as const)("classifies supported Node version %s", (version, expected) => {
    expect(isSupportedNodeVersion(version)).toBe(expected);
  });

  it.each([
    ["1.4.0", true],
    ["1.4.1", true],
    ["2.0.0", true],
    ["1.3.14", false],
    [null, false],
  ] as const)("classifies supported Bun version %s", (version, expected) => {
    expect(isSupportedBunVersion(version)).toBe(expected);
  });

  it("throws via exit when runtime is too old", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        throw new Error("exit");
      }),
    };
    const details = {
      kind: "node" as const,
      version: "20.0.0",
      execPath: "/usr/bin/node",
      pathEnv: "/usr/bin",
      hasNodeSqlite: false,
      sqliteVersion: null,
    };
    await expect(assertSupportedRuntime(runtime, details)).rejects.toThrow("exit");
    expect(runtime.error).toHaveBeenCalledOnce();
    expect(runtime.error).toHaveBeenCalledWith(
      [
        "openclaw requires Node >=24.16.0 <25, or >=26.1.0.",
        "Detected: node 20.0.0 (exec: /usr/bin/node).",
        "PATH searched: /usr/bin",
        "Install Node: https://nodejs.org/en/download",
        "Upgrade Node and re-run openclaw.",
      ].join("\n"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("returns silently when runtime meets requirements", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const details = {
      kind: "node" as const,
      version: "24.16.0",
      execPath: "/usr/bin/node",
      pathEnv: "/usr/bin",
      hasNodeSqlite: true,
      sqliteVersion: "3.53.3",
      sqliteProbe: { available: true, version: "3.53.3", text: true, blob: true, json: true },
    };
    await expect(assertSupportedRuntime(runtime, details)).resolves.toBeUndefined();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("accepts Bun when the runtime provides WAL-reset-safe node:sqlite", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const details = {
      kind: "bun" as const,
      version: "1.4.0",
      execPath: "/usr/bin/bun",
      pathEnv: "/usr/bin",
      hasNodeSqlite: true,
      sqliteVersion: "3.53.2",
    };
    await expect(assertSupportedRuntime(runtime, details)).resolves.toBeUndefined();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("reports a SQLite selection failure through the runtime diagnostic sink", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const sqliteSelectionError =
      "Cannot use SQLite library /nonexistent.dylib: missing file. " +
      "Fix or unset OPENCLAW_SQLITE_LIBRARY; install a supported library with brew install sqlite.";
    await assertSupportedRuntime(runtime, {
      kind: "bun",
      version: "1.4.2",
      execPath: "/usr/bin/bun",
      pathEnv: "/usr/bin",
      hasNodeSqlite: true,
      sqliteVersion: "3.53.4",
      sqliteSelectionError,
    });
    expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
      `${sqliteSelectionError}\nDetected: bun 1.4.2 (exec: /usr/bin/bun).`,
    );
    expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("rejects Bun when it does not provide node:sqlite", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        throw new Error("exit");
      }),
    };
    const details = {
      kind: "bun" as const,
      version: "1.3.14",
      execPath: "/usr/bin/bun",
      pathEnv: "/usr/bin",
      hasNodeSqlite: false,
      sqliteVersion: null,
    };

    await expect(assertSupportedRuntime(runtime, details)).rejects.toThrow("exit");
    expect(runtime.error).toHaveBeenCalledWith(
      [
        "openclaw requires Bun 1.4 or newer with WAL-reset-safe node:sqlite (SQLite 3.51.3+ or a patched 3.50.x/3.44.x release).",
        "Detected: bun 1.3.14 (exec: /usr/bin/bun).",
        "Detected SQLite: unavailable.",
        "PATH searched: /usr/bin",
        "Install Bun: https://bun.com/docs/installation",
        "Upgrade Bun or run OpenClaw with a supported Node release.",
      ].join("\n"),
    );
  });

  it("rejects Bun below 1.4 even when node:sqlite is available", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        throw new Error("exit");
      }),
    };

    await expect(
      assertSupportedRuntime(runtime, {
        kind: "bun",
        version: "1.3.14",
        execPath: "/usr/bin/bun",
        pathEnv: "/usr/bin",
        hasNodeSqlite: true,
        sqliteVersion: "3.53.2",
      }),
    ).rejects.toThrow("exit");
  });

  it("rejects Bun when its node:sqlite version is not WAL-reset-safe", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        throw new Error("exit");
      }),
    };

    await expect(
      assertSupportedRuntime(runtime, {
        kind: "bun",
        version: "1.4.0",
        execPath: "/usr/bin/bun",
        pathEnv: "/usr/bin",
        hasNodeSqlite: true,
        sqliteVersion: "3.51.2",
      }),
    ).rejects.toThrow("exit");
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Detected SQLite: 3.51.2."));
  });

  it("reports unknown runtimes with fallback labels", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        throw new Error("exit");
      }),
    };
    const details = {
      kind: "unknown" as const,
      version: null,
      execPath: null,
      pathEnv: "(not set)",
      hasNodeSqlite: false,
      sqliteVersion: null,
    };

    await expect(assertSupportedRuntime(runtime, details)).rejects.toThrow("exit");
    expect(runtime.error).toHaveBeenCalledOnce();
    expect(runtime.error).toHaveBeenCalledWith(
      [
        "openclaw requires Node >=24.16.0 <25, or >=26.1.0.",
        "Detected: unknown runtime (exec: unknown).",
        "PATH searched: (not set)",
        "Install Node: https://nodejs.org/en/download",
        "Upgrade Node and re-run openclaw.",
      ].join("\n"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});

describe("runtime failure diagnostics", () => {
  it("preserves configured JSON diagnostics and redaction with the default runtime", async () => {
    const { loggingState } = await import("../logging/state.js");
    const previous = loggingState.overrideSettings;
    const secret = "synthetic-runtime-secret-0123456789";
    state.error.mockClear();
    loggingState.overrideSettings = { consoleStyle: "json" };
    try {
      await expect(
        assertSupportedRuntime(undefined, {
          kind: "node",
          version: "20.0.0",
          execPath: "/usr/bin/node",
          pathEnv: `https://example.test/?token=${secret}`,
          hasNodeSqlite: false,
          sqliteVersion: null,
        }),
      ).rejects.toThrow("runtime exit 1");
      const output = String(state.error.mock.lastCall?.[0]);
      expect(JSON.parse(output)).toMatchObject({
        level: "error",
        message: expect.stringContaining("Detected: node 20.0.0"),
      });
      expect(output).not.toContain(secret);
    } finally {
      loggingState.overrideSettings = previous;
    }
  });
});

describe("sealed worker runtime", () => {
  const originalArgv = process.argv;
  beforeEach(() => {
    vi.resetModules();
    state.error.mockClear();
    state.run.mockClear();
    process.argv = [process.execPath, "worker.mjs"];
  });
  afterEach(() => {
    process.argv = originalArgv;
  });

  it.each(["22.23.2", "26.0.0"])(
    "rejects an explicitly configured worker runtime %s before starting work",
    async (version) => {
      state.version = version;
      state.lossless = false;
      await expect(import("../worker/worker-deploy-entry.js")).rejects.toThrow("runtime exit 1");
      expect(state.run).not.toHaveBeenCalled();
      expect(state.error).toHaveBeenCalledWith(expect.stringContaining("Upgrade Node"));
    },
  );

  it.each(["24.16.0", "26.1.0"])("starts the worker on supported runtime %s", async (version) => {
    state.version = version;
    state.lossless = true;
    await import("../worker/worker-deploy-entry.js");
    expect(state.run).toHaveBeenCalledOnce();
    expect(state.error).not.toHaveBeenCalled();
  });
});
