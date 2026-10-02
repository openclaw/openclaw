import { afterEach, beforeEach, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  mode: "flags" as "flags" | "compile-cache" | "none",
  trace: false,
  runtimeSupported: true,
  events: [] as string[],
  spawnTitle: undefined as string | undefined,
  admissionContext: undefined as string | undefined,
  writer: undefined as ((message: string, error?: unknown) => void | Promise<void>) | undefined,
}));

vi.mock("./infra/is-main.js", () => ({ isMainModule: () => true }));
vi.mock("./infra/openclaw-exec-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./infra/openclaw-exec-env.js")>()),
  ensureOpenClawExecMarkerOnProcess: vi.fn(),
}));
vi.mock("./infra/warning-filter.js", () => ({ installProcessWarningFilter: vi.fn() }));
vi.mock("./infra/runtime-guard.js", () => ({
  isCurrentRuntimeSupported: async () => boundary.runtimeSupported,
  assertSupportedRuntime: async () => {},
}));
vi.mock("./cli/dotenv.js", () => ({
  loadCliDotEnv: () => boundary.events.push("dotenv"),
}));
vi.mock("./cli/startup-trace.js", () => ({
  createGatewayDispatchStartupTrace: () => ({ enabled: boundary.trace, mark: vi.fn() }),
  configureGatewayStartupTraceConsoleFormatting: async () => {
    boundary.events.push("trace formatting");
  },
}));
vi.mock("./entry.compile-cache.js", () => ({
  resolveEntryInstallRoot: () => "/fixture/openclaw",
  enableOpenClawCompileCache: vi.fn(),
  respawnWithoutOpenClawCompileCacheIfNeeded: async (params: {
    prepareWriteError: () => Promise<NonNullable<typeof boundary.writer>>;
  }) => {
    if (boundary.mode !== "compile-cache") {
      return false;
    }
    boundary.writer = await params.prepareWriteError();
    boundary.spawnTitle = process.title;
    boundary.events.push("spawn");
    return true;
  },
}));
vi.mock("./entry.respawn.js", () => ({
  buildCliRespawnPlan: () =>
    boundary.mode === "none" ? null : { command: "node", argv: [], env: {} },
  runCliRespawnPlan: (_plan: unknown, _runtime: unknown, writer: typeof boundary.writer) => {
    boundary.writer = writer;
    boundary.spawnTitle = process.title;
    boundary.events.push("spawn");
  },
}));
vi.mock("./entry.version-fast-path.js", () => ({
  tryHandleRootVersionFastPath: () => boundary.mode === "none",
}));
vi.mock("./cli/update-cli/update-command-admit.js", () => ({
  updateAdmitCommand: async (contextPath: string) => {
    boundary.admissionContext = contextPath;
    boundary.events.push("admission");
    process.exitCode = 2;
  },
}));

const originalArgv = process.argv;
const originalTitle = process.title;
const originalExitCode = process.exitCode;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  boundary.events = [];
  boundary.runtimeSupported = true;
  boundary.writer = undefined;
  boundary.spawnTitle = undefined;
  boundary.admissionContext = undefined;
  process.title = "doctor-launcher-fixture";
  process.argv = [process.execPath, "/fixture/openclaw/dist/entry.js", "doctor", "--fix"];
});
afterEach(() => {
  process.argv = originalArgv;
  process.title = originalTitle;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([true, false])(
  "prepares early runtime diagnostics after async support resolves to %s",
  async (supported) => {
    boundary.mode = "compile-cache";
    boundary.trace = false;
    boundary.runtimeSupported = supported;

    await import("./entry.js");

    expect(boundary.events).toEqual(
      supported ? ["spawn"] : ["dotenv", "trace formatting", "spawn"],
    );
  },
);

it.each([
  { mode: "flags", trace: false },
  { mode: "flags", trace: true },
  { mode: "compile-cache", trace: false },
  { mode: "compile-cache", trace: true },
] as const)(
  "preserves the idle Doctor launcher through $mode respawn diagnostics (trace: $trace)",
  async ({ mode, trace }) => {
    boundary.mode = mode;
    boundary.trace = trace;
    const launcherTitle = process.title;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => {
      boundary.events.push("diagnostic");
      return true;
    });

    await import("./entry.js");

    expect(boundary.spawnTitle).toBe(launcherTitle);
    expect(process.title).toBe(launcherTitle);
    expect(boundary.events).toEqual(trace ? ["dotenv", "trace formatting", "spawn"] : ["spawn"]);
    expect(stderr).not.toHaveBeenCalled();
    expect(boundary.writer).toBeTypeOf("function");
    await boundary.writer?.("startup failed");
    expect(boundary.events).toEqual(
      trace
        ? ["dotenv", "trace formatting", "spawn", "diagnostic"]
        : ["spawn", "dotenv", "trace formatting", "diagnostic"],
    );
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("startup failed"));
  },
);

it("names the final executing CLI after startup respawn decisions", async () => {
  boundary.mode = "none";
  boundary.trace = false;
  process.argv = [process.execPath, "/fixture/openclaw/dist/entry.js", "--version"];

  await import("./entry.js");

  expect(boundary.spawnTitle).toBeUndefined();
  expect(process.title).toBe("openclaw");
});

it("runs internal admission with root options before runtime recovery, cache activation, or respawn", async () => {
  boundary.mode = "compile-cache";
  boundary.trace = true;
  boundary.runtimeSupported = false;
  const { isUpdateAdmissionAuthorityEnvKey } = await import("./infra/update-admission-contract.js");
  for (const key of Object.keys(process.env)) {
    if (isUpdateAdmissionAuthorityEnvKey(key)) {
      vi.stubEnv(key, undefined);
    }
  }
  for (const key of ["OPENCLAW_PROFILE", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]) {
    vi.stubEnv(key, undefined);
  }
  process.argv = [
    process.execPath,
    "/fixture/openclaw/dist/entry.js",
    "--profile",
    "admission-fixture",
    "update",
    "admit",
    "--context",
    "/fixture/context.json",
    "--no-color",
  ];
  await import("./entry.js");
  expect(boundary.events).toEqual(["admission"]);
  expect(boundary.admissionContext).toBe("/fixture/context.json");
  expect(process.env.OPENCLAW_PROFILE).toBe("admission-fixture");
  expect(process.exitCode).toBe(2);
  const compileCache = await import("./entry.compile-cache.js");
  expect(compileCache.enableOpenClawCompileCache).not.toHaveBeenCalled();
});

it.each([[], ["--context"], ["--context", "/fixture/context.json", "extra"]])(
  "rejects malformed admission argv before runtime recovery or respawn (%j)",
  async (...args) => {
    boundary.mode = "compile-cache";
    boundary.trace = true;
    boundary.runtimeSupported = false;
    process.argv = [
      process.execPath,
      "/fixture/openclaw/dist/entry.js",
      "update",
      "admit",
      ...args,
    ];
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    await import("./entry.js");

    expect(boundary.events).toEqual([]);
    expect(process.exitCode).toBe(2);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledOnce();
    const compileCache = await import("./entry.compile-cache.js");
    expect(compileCache.enableOpenClawCompileCache).not.toHaveBeenCalled();
  },
);
