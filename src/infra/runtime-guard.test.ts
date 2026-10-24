import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { PROCESS_NODE_VERSION_CHECK } from "../../node-version.mjs";
import {
  assertSupportedRuntime,
  isSupportedBunVersion,
  isSupportedNodeVersion,
  nodeVersionSatisfiesEngine,
  parseSemver,
} from "./runtime-guard.js";

const state = vi.hoisted(() => ({
  version: "24.22.1",
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
// mock-isolation: keep the worker's process-local agent/exec state out of admission tests.
vi.mock("../worker/worker.runtime.js", () => ({
  createWorkerRuntimeEnvironment: vi.fn(),
  loadWorkerTurnRuntime: vi.fn(),
  runWorkerDescriptor: vi.fn(),
}));

function createExitingRuntime() {
  return {
    ...createRuntime(),
    exit: vi.fn(() => {
      throw new Error("exit");
    }),
  };
}

function runtimeDetails(
  kind: "node" | "bun",
  overrides: Partial<NonNullable<Parameters<typeof assertSupportedRuntime>[1]>> = {},
) {
  return {
    kind,
    version: kind === "bun" ? "1.4.3" : "24.22.1",
    execPath: `/usr/bin/${kind}`,
    pathEnv: "/usr/bin",
    hasNodeSqlite: true,
    sqliteVersion: "3.53.2",
    ...overrides,
  };
}

function createRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

describe("runtime-guard", () => {
  it.each(["24.22.0", "26.12.0"])(
    "refuses Node %s with compromised-key trust even when SQLite is healthy",
    async (version) => {
      state.version = version;
      state.lossless = true;
      const runtime = createExitingRuntime();
      await expect(assertSupportedRuntime(runtime)).rejects.toThrow("exit");
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Upgrade Node"));
    },
  );
  it("validates ordinary CLI runtimes without initializing SQLite worker policy", async () => {
    state.initializeSqlite.mockClear();
    state.version = "24.22.1";
    state.lossless = true;
    await assertSupportedRuntime(createExitingRuntime());
    expect(state.initializeSqlite).not.toHaveBeenCalled();
  });
  it("warns once while admitting capable Node 22 diagnostics", async () => {
    const runtime = createRuntime();
    const details = runtimeDetails("node", { version: "22.23.2", sqliteVersion: null });
    await assertSupportedRuntime(runtime, details, ["node", "openclaw", "update", "status"]);
    await assertSupportedRuntime(runtime, details, ["node", "openclaw", "update", "status"]);
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
      "Running on an unsupported Node (22.23.2); diagnostics may show truncated text",
    );
  });

  it.each([
    ["24.22.1", true, true],
    ["24.22.1", false, false],
    ["24.15.0+vendor.1", true, false],
    ["24.15.0+vendor.1", false, false],
  ] as const)("gates Node %s with lossless SQLite %s", async (version, lossless, admitted) => {
    const runtime = createRuntime();
    const details = runtimeDetails("node", {
      version,
      sqliteVersion: "3.51.3",
      sqliteProbe: { available: true, version: "3.51.3", text: lossless, blob: true, json: true },
    });
    await assertSupportedRuntime(runtime, details);
    expect(runtime.exit).toHaveBeenCalledTimes(admitted ? 0 : 1);
    if (!admitted) {
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining(lossless ? "openclaw requires Node" : "nodejs/node#61954"),
      );
    }
  });

  it.each([
    ["--version"],
    ["-V"],
    ["-v"],
    ["--help"],
    ["-h"],
    ["gateway", "status"],
    ["gateway", "status", "--deep"],
    ["doctor"],
    ["doctor", "--lint"],
    ["doctor", "--lint", "--json"],
    ["update", "status"],
    ["update"],
    ["triage", "--json"],
    ["triage", "--non-interactive"],
    ["--profile", "fixture", "gateway", "status", "--deep"],
  ])("allows unsupported Node diagnostics: %j", async (...args) => {
    const runtime = createRuntime();
    await assertSupportedRuntime(
      runtime,
      runtimeDetails("node", { version: "22.23.2", sqliteVersion: null }),
      ["node", "openclaw", ...args],
    );
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it.each([
    [],
    ["gateway"],
    ["gateway", "start"],
    ["gateway", "run"],
    ["status"],
    ["doctor", "--fix"],
    ["doctor", "--lint", "--repair"],
    ["doctor", "--yes"],
    ["doctor", "--state-sqlite", "compact"],
    ["triage"],
    ["triage", "--json", "--run"],
    ["triage", "--non-interactive", "--agent", "codex"],
    ["update", "repair"],
    ["database", "vacuum"],
    ["--profile", "--help", "gateway", "start"],
    ["agent", "--message", "--help"],
  ])("refuses unsupported Node mutation: %j", async (...args) => {
    const runtime = createRuntime();
    await assertSupportedRuntime(
      runtime,
      runtimeDetails("node", { version: "26.0.0", sqliteVersion: null }),
      ["node", "openclaw", ...args],
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it.each([
    { version: "20.0.0", hasNodeSqlite: true },
    { version: "20.0.0", hasNodeSqlite: false },
    { version: "22.23.2", hasNodeSqlite: false },
  ])(
    "refuses diagnostic execution without capability: $version SQLite=$hasNodeSqlite",
    async (details) => {
      const runtime = createRuntime();
      await assertSupportedRuntime(
        runtime,
        runtimeDetails("node", { sqliteVersion: null, ...details }),
        ["node", "openclaw", "update", "status"],
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
    },
  );

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
    const engine = ">=24.22.1 <25 || >=26.12.1";
    expect(nodeVersionSatisfiesEngine("22.23.2", engine)).toBe(false);
    expect(nodeVersionSatisfiesEngine("22.22.2", engine)).toBe(false);
    expect(nodeVersionSatisfiesEngine("23.11.0", engine)).toBe(false);
    expect(nodeVersionSatisfiesEngine("24.14.1", engine)).toBe(false);
    expect(nodeVersionSatisfiesEngine("24.15.0+vendor.1", engine)).toBe(false);
    expect(nodeVersionSatisfiesEngine("24.22.1", engine)).toBe(true);
    expect(nodeVersionSatisfiesEngine("25.8.1", engine)).toBe(false);
    expect(nodeVersionSatisfiesEngine("25.9.0", engine)).toBe(false);
    expect(nodeVersionSatisfiesEngine("26.0.0", engine)).toBe(false);
    expect(nodeVersionSatisfiesEngine("26.12.1", engine)).toBe(true);
    expect(nodeVersionSatisfiesEngine(null, engine)).toBe(false);
    expect(nodeVersionSatisfiesEngine("unknown", engine)).toBe(false);
  });

  it.each([
    ["22.23.2", false],
    ["23.11.0", false],
    ["24.15.0", false],
    ["24.22.1", true],
    ["25.9.0", false],
    ["26.0.0", false],
    ["26.12.1", true],
    ["27.0.0", true],
    ["v27.0.0-head", true],
    ["27.0.0-nightly20261018f88a1d25e9", true],
    ["27.0.0-rc.1+vendor.1", true],
    ["24.22.1-rc.1", false],
    ["26.12.1-rc.1", false],
    ["27.0.0-01", false],
    ["27.0.0-nightly..1", false],
    ["27.0.0-", false],
    ["24.22.1+local.1", true],
    ["24.15.0-rc.1", false],
    ["25.9.1-nightly.20260714", false],
    ["24.15", false],
    ["garbage24.15.0suffix", false],
    ["24.15.0suffix", false],
    [null, false],
  ] as const)("classifies supported Node version %s", (version, expected) => {
    expect(isSupportedNodeVersion(version)).toBe(expected);
    expect(
      runInNewContext(PROCESS_NODE_VERSION_CHECK, { process: { versions: { node: version } } }),
    ).toBe(expected);
  });

  it.each([
    ["1.4.0", false],
    ["1.4.1", false],
    ["1.4.2", false],
    ["1.4.3", true],
    ["1.4.3-canary.1+65d94e715", true],
    ["2.0.0", true],
    ["1.3.14", false],
    [null, false],
  ] as const)("classifies supported Bun version %s", (version, expected) => {
    expect(isSupportedBunVersion(version)).toBe(expected);
  });

  it.each([
    {
      label: "too old",
      details: runtimeDetails("node", {
        version: "20.0.0",
        hasNodeSqlite: false,
        sqliteVersion: null,
      }),
      detected: "node 20.0.0 (exec: /usr/bin/node)",
      path: "/usr/bin",
    },
    {
      label: "unknown",
      details: {
        kind: "unknown",
        version: null,
        execPath: null,
        pathEnv: "(not set)",
        hasNodeSqlite: false,
        sqliteVersion: null,
      } as const,
      detected: "unknown runtime (exec: unknown)",
      path: "(not set)",
    },
  ])("throws via exit when runtime is $label", async ({ details, detected, path }) => {
    const runtime = createExitingRuntime();
    await expect(assertSupportedRuntime(runtime, details)).rejects.toThrow("exit");
    expect(runtime.error).toHaveBeenCalledOnce();
    expect(runtime.error).toHaveBeenCalledWith(
      [
        "openclaw requires Node >=24.22.1 <25, or >=26.12.1.",
        `Detected: ${detected}.`,
        `PATH searched: ${path}`,
        "Install Node: https://nodejs.org/en/download",
        "Upgrade Node and re-run openclaw.",
      ].join("\n"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it.each([
    runtimeDetails("node", {
      sqliteVersion: "3.53.3",
      sqliteProbe: { available: true, version: "3.53.3", text: true, blob: true, json: true },
    }),
    runtimeDetails("bun"),
  ])("returns silently when $kind runtime meets requirements", async (details) => {
    const runtime = createRuntime();
    await expect(assertSupportedRuntime(runtime, details)).resolves.toBeUndefined();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("reports a SQLite selection failure through the runtime diagnostic sink", async () => {
    const runtime = createRuntime();
    const sqliteSelectionError =
      "Cannot use SQLite library /nonexistent.dylib: missing file. " +
      "Fix or unset OPENCLAW_SQLITE_LIBRARY; install a supported library with brew install sqlite.";
    await assertSupportedRuntime(
      runtime,
      runtimeDetails("bun", {
        sqliteVersion: "3.53.4",
        sqliteSelectionError,
      }),
    );
    expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
      `${sqliteSelectionError}\nDetected: bun 1.4.3 (exec: /usr/bin/bun).`,
    );
    expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("rejects supported Bun without node:sqlite", async () => {
    const runtime = createExitingRuntime();
    const details = runtimeDetails("bun", {
      hasNodeSqlite: false,
      sqliteVersion: null,
    });

    await expect(assertSupportedRuntime(runtime, details)).rejects.toThrow("exit");
    expect(runtime.error).toHaveBeenCalledWith(
      [
        "openclaw requires Bun 1.4.3 or newer with WAL-reset-safe node:sqlite (SQLite 3.51.3+ or a patched 3.50.x/3.44.x release).",
        "Detected: bun 1.4.3 (exec: /usr/bin/bun).",
        "Detected SQLite: unavailable.",
        "PATH searched: /usr/bin",
        "Install Bun: https://bun.com/docs/installation",
        "Upgrade Bun or run OpenClaw with a supported Node release.",
      ].join("\n"),
    );
  });

  it.each([
    { version: "1.4.0", sqliteVersion: "3.53.2" },
    { version: "1.4.1", sqliteVersion: "3.53.2" },
    { version: "1.4.2", sqliteVersion: "3.53.2" },
    { version: "1.4.3", sqliteVersion: "3.51.2" },
  ])("rejects Bun $version with SQLite $sqliteVersion", async (details) => {
    const runtime = createExitingRuntime();
    await expect(assertSupportedRuntime(runtime, runtimeDetails("bun", details))).rejects.toThrow(
      "exit",
    );
    if (details.sqliteVersion === "3.51.2") {
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("Detected SQLite: 3.51.2."),
      );
    }
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
        assertSupportedRuntime(
          undefined,
          runtimeDetails("node", {
            version: "20.0.0",
            pathEnv: `https://example.test/?token=${secret}`,
            hasNodeSqlite: false,
            sqliteVersion: null,
          }),
        ),
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

  it.each([
    { version: "22.23.2", supported: false },
    { version: "26.0.0", supported: false },
    { version: "24.22.1", supported: true },
    { version: "26.12.1", supported: true },
  ])("handles worker runtime $version", async ({ version, supported }) => {
    state.version = version;
    state.lossless = supported;
    const stderr = supported ? undefined : vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await expect(import("../worker/worker-deploy-entry.js")).resolves.toBeDefined();
    expect(process.exitCode).toBe(supported ? undefined : 1);
    expect(destroyStdin).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(state.run).toHaveBeenCalledTimes(supported ? 1 : 0);
    if (supported) {
      expect(state.error).not.toHaveBeenCalled();
    } else {
      expect(stderr).toHaveBeenCalledExactlyOnceWith("exit 1\n");
      expect(state.error).toHaveBeenCalledWith(expect.stringContaining("Upgrade Node"));
    }
  });
});
