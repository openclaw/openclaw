import { afterEach, beforeEach, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  mode: "flags" as "flags" | "compile-cache" | "none",
  trace: false,
  runtimeSupported: true,
  events: [] as string[],
  spawnTitle: undefined as string | undefined,
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

const originalArgv = process.argv;
const originalTitle = process.title;

beforeEach(() => {
  vi.resetModules();
  boundary.events = [];
  boundary.runtimeSupported = true;
  boundary.writer = undefined;
  boundary.spawnTitle = undefined;
  process.title = "doctor-launcher-fixture";
  process.argv = [process.execPath, "/fixture/openclaw/dist/entry.js", "doctor", "--fix"];
});
afterEach(() => {
  process.argv = originalArgv;
  process.title = originalTitle;
  vi.restoreAllMocks();
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
