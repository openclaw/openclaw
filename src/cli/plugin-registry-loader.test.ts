import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { flushDiagnosticsTimeline } from "../infra/diagnostics-timeline.js";
import { measureCliCommandStartup } from "./command-startup-timing.js";

const ensurePluginRegistryLoadedMock = vi.hoisted(() => vi.fn());
const readRegistryMock = vi.hoisted(() =>
  vi.fn(async (): Promise<{ entries: Array<{ backendId?: string }> }> => ({ entries: [] })),
);
const tempDirs = createTempDirTracker();

vi.mock("../plugins/runtime/runtime-registry-loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/runtime/runtime-registry-loader.js")>()),
  ensurePluginRegistryLoaded: ensurePluginRegistryLoadedMock,
}));

// mock-isolation: CLI startup controls sandbox entries without reading persisted SQLite state.
vi.mock("../agents/sandbox/registry.js", () => ({ readRegistry: readRegistryMock }));

let originalForceStderr: boolean;
let ensureCliPluginRegistryLoaded: typeof import("./plugin-registry-loader.js").ensureCliPluginRegistryLoaded;
let loggingState: typeof import("../logging/state.js").loggingState;

beforeAll(async () => {
  ({ ensureCliPluginRegistryLoaded } = await import("./plugin-registry-loader.js"));
  ({ loggingState } = await import("../logging/state.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  readRegistryMock.mockResolvedValue({ entries: [] });
  originalForceStderr = loggingState.forceConsoleToStderr;
  loggingState.forceConsoleToStderr = false;
});

afterEach(() => {
  flushDiagnosticsTimeline();
  tempDirs.cleanup();
  loggingState.forceConsoleToStderr = originalForceStderr;
  vi.unstubAllEnvs();
});

it.each<{
  initial: boolean;
  finishFirst: "first" | "second";
  reject: boolean;
  routeSecond: boolean;
}>([
  { initial: false, finishFirst: "first", reject: false, routeSecond: true },
  { initial: false, finishFirst: "second", reject: true, routeSecond: true },
  { initial: true, finishFirst: "first", reject: false, routeSecond: true },
  { initial: false, finishFirst: "first", reject: false, routeSecond: false },
] as const)(
  "settles loads ($finishFirst first, reject=$reject, routeSecond=$routeSecond) to stderr=$initial",
  async ({ initial, finishFirst, reject, routeSecond }) => {
    loggingState.forceConsoleToStderr = initial;
    const gate = () => Promise.withResolvers<void>();
    const started = { first: gate(), second: gate() };
    const resume = { first: gate(), second: gate() };
    const captured: boolean[] = [];
    const failure = new Error("Plugin activation failed");
    const load = async (id: keyof typeof started) => {
      started[id].resolve();
      await resume[id].promise;
      captured.push(loggingState.forceConsoleToStderr);
      if (reject && id === finishFirst) {
        throw failure;
      }
    };
    ensurePluginRegistryLoadedMock
      .mockImplementationOnce(() => load("first"))
      .mockImplementationOnce(() => load("second"));
    const start = (routeLogsToStderr: boolean) =>
      ensureCliPluginRegistryLoaded({ scope: "all", routeLogsToStderr }).then(
        () => undefined,
        (error: unknown) => error,
      );
    const pending = { first: start(true), second: start(routeSecond) };
    const finishLast = finishFirst === "first" ? "second" : "first";
    try {
      await Promise.all([started.first.promise, started.second.promise]);
      expect(loggingState.forceConsoleToStderr).toBe(true);
      resume[finishFirst].resolve();
      expect(await pending[finishFirst]).toBe(reject ? failure : undefined);
      expect(loggingState.forceConsoleToStderr).toBe(routeSecond || finishFirst === "second");
      resume[finishLast].resolve();
      expect(await pending[finishLast]).toBeUndefined();
      expect(captured).toEqual([true, routeSecond]);
      expect(loggingState.forceConsoleToStderr).toBe(initial);
    } finally {
      resume.first.resolve();
      resume.second.resolve();
      await Promise.all([pending.first, pending.second]);
    }
  },
);

it("forwards explicit config snapshots to plugin loading", async () => {
  const params = {
    scope: "configured-channels" as const,
    config: { channels: { quietchat: { enabled: true } } },
  };
  await ensureCliPluginRegistryLoaded(params);
  expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith(params);
});

it("includes persisted runtime owners when loading sandbox managers", async () => {
  readRegistryMock.mockResolvedValue({
    entries: [{ backendId: "openshell" }, { backendId: "docker" }, { backendId: "openshell" }],
  });

  await ensureCliPluginRegistryLoaded({ scope: "sandbox-management" });

  expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith({
    scope: "sandbox-backends",
    persistedSandboxBackendIds: ["docker", "openshell"],
  });
});

it("attributes module import separately from runtime loading", async () => {
  const timelinePath = join(tempDirs.make("openclaw-plugin-registry-startup-"), "timeline.jsonl");
  vi.stubEnv("OPENCLAW_DIAGNOSTICS", "timeline");
  vi.stubEnv("OPENCLAW_DIAGNOSTICS_TIMELINE_PATH", timelinePath);

  await measureCliCommandStartup("plugin-registry", () =>
    ensureCliPluginRegistryLoaded({ scope: "all" }),
  );

  flushDiagnosticsTimeline();
  const events = (await readFile(timelinePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const starts = events.filter((event) => event.type === "span.start");
  const outer = starts.find(
    (event) => (event.attributes as { stage?: string } | undefined)?.stage === "plugin-registry",
  );
  expect(outer).toBeDefined();
  expect(
    starts
      .filter((event) => event.parentSpanId === outer?.spanId)
      .map((event) => (event.attributes as { stage?: string } | undefined)?.stage),
  ).toEqual(["plugin-registry-module-import", "plugin-registry-runtime-load"]);
});
