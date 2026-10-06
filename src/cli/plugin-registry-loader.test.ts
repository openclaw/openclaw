// Plugin registry loader tests cover CLI plugin registry loading and cache reset behavior.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { flushDiagnosticsTimeline } from "../infra/diagnostics-timeline.js";
import { measureCliCommandStartup } from "./command-startup-timing.js";

const ensurePluginRegistryLoadedMock = vi.hoisted(() => vi.fn());
const readRegistryMock = vi.hoisted(() =>
  vi.fn(async (): Promise<{ entries: Array<{ backendId?: string }> }> => ({ entries: [] })),
);
const tempDirs = createTempDirTracker();

vi.mock("./plugin-registry.js", () => ({
  ensurePluginRegistryLoaded: ensurePluginRegistryLoadedMock,
}));

vi.mock("../agents/sandbox/registry.js", () => ({
  readRegistry: readRegistryMock,
}));

describe("plugin-registry-loader", () => {
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

  it.each(["fulfilled", "rejected"])(
    "keeps plugin logs on stderr until async loading is %s, then restores state",
    async (settlement) => {
      const captured: boolean[] = [];
      const started = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const failure = new Error("Plugin activation failed");
      ensurePluginRegistryLoadedMock.mockImplementation(async () => {
        captured.push(loggingState.forceConsoleToStderr);
        started.resolve();
        await resume.promise;
        captured.push(loggingState.forceConsoleToStderr);
        if (settlement === "rejected") {
          throw failure;
        }
      });

      const loading = ensureCliPluginRegistryLoaded({
        scope: "configured-channels",
        routeLogsToStderr: true,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await started.promise;
        expect(loggingState.forceConsoleToStderr).toBe(true);
      } finally {
        resume.resolve();
        await loading;
      }

      expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith({
        scope: "configured-channels",
      });
      expect(await loading).toBe(settlement === "rejected" ? failure : undefined);
      expect(captured).toEqual([true, true]);
      expect(loggingState.forceConsoleToStderr).toBe(false);
    },
  );

  it("keeps stdout routing unchanged when stderr routing is not requested", async () => {
    const captured: boolean[] = [];
    ensurePluginRegistryLoadedMock.mockImplementation(() => {
      captured.push(loggingState.forceConsoleToStderr);
    });

    await ensureCliPluginRegistryLoaded({
      scope: "all",
    });

    expect(captured).toEqual([false]);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it.each(
    [false, true].flatMap((initial) =>
      (["first", "second"] as const).flatMap((finishFirst) =>
        [false, true].map((reject) => ({ initial, finishFirst, reject })),
      ),
    ),
  )(
    "settles overlapping loads ($finishFirst first, reject=$reject) back to stderr=$initial",
    async ({ initial, finishFirst, reject }) => {
      loggingState.forceConsoleToStderr = initial;
      const started = {
        first: Promise.withResolvers<void>(),
        second: Promise.withResolvers<void>(),
      };
      const resume = {
        first: Promise.withResolvers<void>(),
        second: Promise.withResolvers<void>(),
      };
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
      const start = () =>
        ensureCliPluginRegistryLoaded({ scope: "all", routeLogsToStderr: true }).then(
          () => undefined,
          (error: unknown) => error,
        );
      const pending = { first: start(), second: start() };
      const finishLast = finishFirst === "first" ? "second" : "first";
      try {
        await Promise.all([started.first.promise, started.second.promise]);
        resume[finishFirst].resolve();
        expect(await pending[finishFirst]).toBe(reject ? failure : undefined);
        expect(loggingState.forceConsoleToStderr).toBe(true);
        resume[finishLast].resolve();
        expect(await pending[finishLast]).toBeUndefined();
        expect(captured).toEqual([true, true]);
        expect(loggingState.forceConsoleToStderr).toBe(initial);
      } finally {
        resume.first.resolve();
        resume.second.resolve();
        await Promise.all([pending.first, pending.second]);
      }
    },
  );

  it("does not retain another load's stderr routing when routing is not requested", async () => {
    const started = Promise.withResolvers<void>();
    const routed = Promise.withResolvers<void>();
    const unrouted = Promise.withResolvers<void>();
    ensurePluginRegistryLoadedMock
      .mockImplementationOnce(() => routed.promise)
      .mockImplementationOnce(() => {
        started.resolve();
        return unrouted.promise;
      });
    const first = ensureCliPluginRegistryLoaded({ scope: "all", routeLogsToStderr: true });
    const second = ensureCliPluginRegistryLoaded({ scope: "all", routeLogsToStderr: false });
    try {
      await started.promise;
      expect(loggingState.forceConsoleToStderr).toBe(true);
      routed.resolve();
      await first;
      expect(loggingState.forceConsoleToStderr).toBe(false);
      unrouted.resolve();
      await second;
      expect(loggingState.forceConsoleToStderr).toBe(false);
    } finally {
      routed.resolve();
      unrouted.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  it("forwards explicit config snapshots to plugin loading", async () => {
    const config = { channels: { quietchat: { enabled: true } } } as never;
    const activationSourceConfig = { channels: { quietchat: { enabled: true } } } as never;

    await ensureCliPluginRegistryLoaded({
      scope: "configured-channels",
      config,
      activationSourceConfig,
    });

    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "configured-channels",
      config,
      activationSourceConfig,
    });
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
    const dir = tempDirs.make("openclaw-plugin-registry-startup-");
    const timelinePath = join(dir, "timeline.jsonl");
    vi.stubEnv("OPENCLAW_DIAGNOSTICS", "timeline");
    vi.stubEnv("OPENCLAW_DIAGNOSTICS_TIMELINE_PATH", timelinePath);

    await measureCliCommandStartup("plugin-registry", () =>
      ensureCliPluginRegistryLoaded({
        scope: "all",
      }),
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
});
