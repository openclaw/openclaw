// Covers runtime detection and version support checks.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  assertSupportedRuntime,
  nodeVersionSatisfiesEngine,
  parseSemver,
} from "./runtime-guard.js";

const state = vi.hoisted(() => ({
  version: "24.16.0",
  error: vi.fn(),
  run: vi.fn(),
  diagnosticLoads: 0,
  lossless: true,
  initializeSqlite: vi.fn(),
}));

vi.mock("./bun-sqlite-library.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bun-sqlite-library.js")>()),
  initializeSqliteRuntimeCapabilities: state.initializeSqlite,
}));

vi.mock("../../node-sqlite.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../node-sqlite.mjs")>();
  return {
    ...actual,
    detectCurrentSqliteCapabilities: async () => ({
      ...(await actual.detectCurrentSqliteCapabilities()),
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

function createExitingRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(() => {
      throw new Error("exit");
    }),
  };
}

describe("runtime-guard", () => {
  it("validates ordinary CLI runtimes without initializing SQLite worker policy", async () => {
    state.initializeSqlite.mockClear();
    state.version = "24.16.0";
    state.lossless = true;
    await assertSupportedRuntime(createExitingRuntime());
    expect(state.initializeSqlite).not.toHaveBeenCalled();
  });
  it("warns once while admitting capable Node 22 diagnostics", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const details = {
      kind: "node" as const,
      version: "22.23.2",
      execPath: "/usr/bin/node",
      pathEnv: "/usr/bin",
      hasNodeSqlite: true,
      sqliteVersion: null,
    };
    await assertSupportedRuntime(runtime, details, ["node", "openclaw", "update", "status"]);
    await assertSupportedRuntime(runtime, details, ["node", "openclaw", "update", "status"]);
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
      "Running on an unsupported Node (22.23.2); diagnostics may show truncated text",
    );
  });

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
    const runtime = createExitingRuntime();
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
    const runtime = createExitingRuntime();

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
    const runtime = createExitingRuntime();

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
    const runtime = createExitingRuntime();
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
      ).rejects.toMatchObject({ name: "ExitError", code: 1 });
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
  let destroyStdin: MockInstance<typeof process.stdin.destroy>;
  let disconnect: MockInstance<NonNullable<typeof process.disconnect>>;
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  beforeEach(() => {
    vi.resetModules();
    state.error.mockClear();
    state.run.mockClear();
    process.argv = [process.execPath, "worker.mjs"];
    process.exitCode = undefined;
    // The executable owns stdin and IPC, not the test runner's real transports.
    destroyStdin = vi.spyOn(process.stdin, "destroy").mockReturnThis();
    disconnect = vi.spyOn(process, "disconnect").mockImplementation(() => {});
    vi.stubEnv("OPENCLAW_DEBUG", undefined);
  });
  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(["22.23.2", "26.0.0"])(
    "rejects an explicitly configured worker runtime %s before starting work",
    async (version) => {
      state.version = version;
      state.lossless = false;
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

      await expect(import("../worker/worker-deploy-entry.js")).resolves.toBeDefined();

      expect(process.exitCode).toBe(1);
      expect(stderr).toHaveBeenCalledExactlyOnceWith("exit 1\n");
      expect(destroyStdin).toHaveBeenCalledOnce();
      expect(disconnect).toHaveBeenCalledOnce();
      expect(state.run).not.toHaveBeenCalled();
      expect(state.error).toHaveBeenCalledWith(expect.stringContaining("Upgrade Node"));
    },
  );

  it.each(["24.16.0", "26.1.0"])("starts the worker on supported runtime %s", async (version) => {
    state.version = version;
    state.lossless = true;
    await import("../worker/worker-deploy-entry.js");
    expect(process.exitCode).toBeUndefined();
    expect(destroyStdin).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(state.run).toHaveBeenCalledOnce();
    expect(state.error).not.toHaveBeenCalled();
  });
});
