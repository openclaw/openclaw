import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRuntimeCapabilityLease } from "./capability-lease.js";
import { runPluginRegisterSyncInRegistry } from "./loader-module-runtime.js";
import { createPluginRecord } from "./loader-records.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createPluginMetricsApi } from "./plugin-metrics.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
  withPluginRegistryPreparationScope,
} from "./registry-lifecycle.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginServiceDiagnostics } from "./service-diagnostics.js";

const exporterEnabled: OpenClawConfig = {
  plugins: { entries: { "diagnostics-prometheus": { enabled: true } } },
};

function createApi(...args: Parameters<typeof createApiWithRecord>) {
  return createApiWithRecord(...args).api;
}

function createApiWithRecord(
  id: string,
  config: OpenClawConfig,
  options: {
    activateGlobalSideEffects?: boolean;
    registrationMode?: "full" | "discovery";
    generationOverlap?: boolean;
  } = {},
) {
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    ...(options.activateGlobalSideEffects === false ? { activateGlobalSideEffects: false } : {}),
  });
  const record = createPluginRecord({
    id,
    source: `/plugins/${id}/index.js`,
    origin: "global",
    enabled: true,
    configSchema: false,
    ...(options.generationOverlap ? { generationOverlap: true } : {}),
  });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, {
    config,
    registrationMode: options.registrationMode ?? "full",
  });
  return { api, record, registry: builder.registry };
}

type Families = Parameters<
  NonNullable<ReturnType<typeof createApi>["metrics"]>["register"]
>[0]["families"];

/** Run `api.metrics.register()` inside the plugin's real synchronous register() call. */
function registerInLoader(loaded: ReturnType<typeof createApiWithRecord>, families: Families) {
  let metrics: ReturnType<NonNullable<typeof loaded.api.metrics>["register"]> | undefined;
  runPluginRegisterSyncInRegistry(
    (api) => {
      metrics = api.metrics!.register({ families });
    },
    loaded.api,
    loaded.registry,
    loaded.record.id,
  );
  return metrics!;
}

/** A plugin instance loaded into a registry that the Gateway has published. */
function loadLive(id: string, families: Families, options: { generationOverlap?: boolean } = {}) {
  const loaded = createApiWithRecord(id, exporterEnabled, options);
  const metrics = registerInLoader(loaded, families);
  markPluginRegistryActive(loaded.registry);
  return { ...loaded, metrics, instance: getPluginInstance(loaded.record)! };
}

const names = (mock: ReturnType<typeof vi.fn>) =>
  mock.mock.calls.map((call) => [(call[0] as { name: string }).name, call[2]]);

const leases: Array<ReturnType<typeof createPluginRuntimeCapabilityLease>> = [];

/** Subscribe the way the trusted exporter service does. */
function subscribeAsExporter() {
  const lease = createPluginRuntimeCapabilityLease("diagnostics-prometheus");
  leases.push(lease);
  const diagnostics = createPluginServiceDiagnostics(
    {
      id: "diagnostics-prometheus",
      pluginId: "diagnostics-prometheus",
      origin: "bundled",
      source: "test",
      service: { id: "diagnostics-prometheus", start() {} },
    },
    lease,
  )!;
  const received = vi.fn();
  const retired = vi.fn();
  diagnostics.onPluginMetrics!({ record: received, retire: retired });
  return { lease, received, retired };
}

afterEach(() => {
  for (const lease of leases.splice(0)) {
    lease.revoke();
  }
});

describe("api.metrics", () => {
  it("is defined in the live registry only while a diagnostics exporter is enabled", () => {
    expect(createApi("metrics-off", {}).metrics).toBeUndefined();
    expect(
      createApi("metrics-off-explicit", {
        plugins: { entries: { "diagnostics-prometheus": { enabled: false } } },
      }).metrics,
    ).toBeUndefined();
    expect(
      createApi("metrics-scoped", exporterEnabled, { activateGlobalSideEffects: false }).metrics,
    ).toBeUndefined();
    expect(
      createApi("metrics-discovery", exporterEnabled, { registrationMode: "discovery" }).metrics,
    ).toBeUndefined();
    expect(createApi("metrics-on", exporterEnabled).metrics?.register).toBeTypeOf("function");
    expect(
      createApi("metrics-otel", {
        plugins: { entries: { "diagnostics-otel": { enabled: true } } },
      }).metrics?.register,
    ).toBeTypeOf("function");
  });

  it("delivers host-prefixed samples to the trusted exporter listener", () => {
    const { lease, received } = subscribeAsExporter();
    const { metrics, instance } = loadLive("my-plugin", [
      { name: "retain_total", type: "counter", help: "Retains by outcome", labels: ["outcome"] },
      { name: "recall_seconds", type: "histogram", help: "Recall latency", buckets: [0.1, 1] },
    ]);
    metrics.counter("retain_total").inc({ outcome: "ok" });
    metrics.histogram("recall_seconds").observe({}, 0.12);
    expect(received.mock.calls).toEqual([
      [
        {
          name: "openclaw_plugin_my_plugin_retain_total",
          type: "counter",
          help: "Retains by outcome",
          labels: ["outcome"],
        },
        { outcome: "ok" },
        1,
      ],
      [
        {
          name: "openclaw_plugin_my_plugin_recall_seconds",
          type: "histogram",
          help: "Recall latency",
          labels: [],
          buckets: [0.1, 1],
        },
        {},
        0.12,
      ],
    ]);
    lease.revoke();
    metrics.counter("retain_total").inc({ outcome: "ok" });
    expect(received).toHaveBeenCalledTimes(2);
    return instance.dispose();
  });

  it("drops undeclared label sets and warns once per family", () => {
    const { received } = subscribeAsExporter();
    const warn = vi.fn();
    const metrics = createPluginMetricsApi("labels-plugin", {
      info() {},
      warn,
      error() {},
    }).register({
      families: [{ name: "jobs", type: "gauge", help: "Jobs", labels: ["state"] }],
    });
    metrics.gauge("jobs").set({ state: "queued", extra: "x" }, 1);
    metrics.gauge("jobs").set({}, 1);
    metrics.gauge("jobs").set({ state: "queued" }, 2);
    metrics.gauge("jobs").set({ state: "user@example.com/123 456" }, 3);
    expect(received.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      [{ state: "queued" }, 2],
      [{ state: "other" }, 3],
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("openclaw_plugin_labels_plugin_jobs");
  });

  it("rejects invalid or colliding families at registration", () => {
    const logger = { info() {}, warn() {}, error() {} };
    const api = createPluginMetricsApi("bad-plugin", logger);
    const register = (family: object) =>
      api.register({ families: [family as Parameters<typeof api.register>[0]["families"][0]] });
    expect(() => register({ name: "Bad", type: "gauge", help: "x" })).toThrow("name must match");
    expect(() => register({ name: "hits", type: "counter", help: "x" })).toThrow("_total");
    expect(() => register({ name: "x", type: "gauge", help: "x", labels: ["le"] })).toThrow(
      "invalid label name le",
    );
    expect(() => register({ name: "x", type: "histogram", help: "x", buckets: [1, 1] })).toThrow(
      "strictly ascending",
    );
    expect(() => register({ name: "x", type: "summary", help: "x" })).toThrow("type must be");
    // Plugin ids that normalize to the same prefix cannot claim each other's families.
    createPluginMetricsApi("dup-plugin", logger).register({
      families: [{ name: "x", type: "gauge", help: "x" }],
    });
    expect(() =>
      createPluginMetricsApi("dup_plugin", logger).register({
        families: [{ name: "x", type: "gauge", help: "x" }],
      }),
    ).toThrow("openclaw_plugin_dup_plugin_x is already registered");
  });

  it("reserves histogram _bucket, _sum and _count names in one plugin and across plugins", () => {
    const logger = { info() {}, warn() {}, error() {} };
    const latency = { name: "lat", type: "histogram", help: "Latency", buckets: [1] } as const;
    // Same register() call, in either declaration order.
    for (const suffix of ["bucket", "sum", "count"]) {
      const gauge = { name: `lat_${suffix}`, type: "gauge", help: "x" } as const;
      expect(() =>
        createPluginMetricsApi("hist-plugin", logger).register({ families: [latency, gauge] }),
      ).toThrow(`openclaw_plugin_hist_plugin_lat_${suffix} conflicts with`);
      expect(() =>
        createPluginMetricsApi("hist-plugin", logger).register({ families: [gauge, latency] }),
      ).toThrow("openclaw_plugin_hist_plugin_lat conflicts with");
    }
    // Across plugins: plugin "a" histogram x owns openclaw_plugin_a_x_count, which plugin
    // "a_x" would otherwise export as its gauge "count".
    createPluginMetricsApi("a", logger).register({
      families: [{ name: "x", type: "histogram", help: "x", buckets: [1] }],
    });
    expect(() =>
      createPluginMetricsApi("a_x", logger).register({
        families: [{ name: "count", type: "gauge", help: "x" }],
      }),
    ).toThrow("openclaw_plugin_a_x_count conflicts with openclaw_plugin_a_x");
    // And the reverse: a histogram whose derived names are already taken.
    createPluginMetricsApi("b_y", logger).register({
      families: [{ name: "sum", type: "gauge", help: "x" }],
    });
    expect(() =>
      createPluginMetricsApi("b", logger).register({
        families: [{ name: "y", type: "histogram", help: "x", buckets: [1] }],
      }),
    ).toThrow("openclaw_plugin_b_y conflicts with openclaw_plugin_b_y_sum");
  });

  it("drops only stale families when the same instance registers again", async () => {
    const { received, retired } = subscribeAsExporter();
    const {
      metrics: first,
      instance,
      api,
    } = loadLive("rereg-plugin", [
      { name: "up", type: "gauge", help: "Up" },
      { name: "depth", type: "gauge", help: "Depth" },
    ]);
    expect(retired).not.toHaveBeenCalled();
    const second = api.metrics!.register({
      families: [
        { name: "up", type: "gauge", help: "Up" },
        { name: "up_total", type: "counter", help: "Up" },
      ],
    });
    expect(retired.mock.calls).toEqual([[["openclaw_plugin_rereg_plugin_depth"]]]);
    first.gauge("depth").set({}, 7);
    second.gauge("up").set({}, 1);
    second.counter("up_total").inc();
    expect(names(received)).toEqual([
      ["openclaw_plugin_rereg_plugin_up", 1],
      ["openclaw_plugin_rereg_plugin_up_total", 1],
    ]);
    retired.mockClear();
    await instance.dispose();
    expect(retired.mock.calls).toEqual([
      [["openclaw_plugin_rereg_plugin_up", "openclaw_plugin_rereg_plugin_up_total"]],
    ]);
    second.gauge("up").set({}, 2);
    expect(received).toHaveBeenCalledTimes(2);
    expect(() =>
      api.metrics!.register({ families: [{ name: "up", type: "gauge", help: "Up" }] }),
    ).toThrow("no longer current");
    // The released names are free for the next instance of the plugin.
    const next = loadLive("rereg-plugin", [{ name: "up_total", type: "counter", help: "Up" }]);
    await next.instance.dispose();
  });

  it("keeps the live instance's families when a reload fails and the instance resumes", async () => {
    const { received, retired } = subscribeAsExporter();
    const live = loadLive("reload-plugin", [{ name: "depth", type: "gauge", help: "Depth" }]);
    live.metrics.gauge("depth").set({}, 1);

    // The replacement registers during preparation, before it is committed.
    const candidate = createApiWithRecord("reload-plugin", exporterEnabled);
    const next = registerInLoader(candidate, [
      { name: "depth", type: "gauge", help: "Depth" },
      { name: "fresh", type: "gauge", help: "Fresh" },
    ]);
    expect(retired).not.toHaveBeenCalled();
    // The uncommitted replacement is not current; the live instance still is.
    next.gauge("fresh").set({}, 9);
    live.metrics.gauge("depth").set({}, 2);

    // Reload pauses the live instance; its samples wait for the outcome.
    live.instance.quiesce();
    live.metrics.gauge("depth").set({}, 3);

    // The replacement fails: its registry is retired unpublished and its instance disposed.
    markPluginRegistryRetired(candidate.registry);
    await getPluginInstance(candidate.record)!.dispose();
    expect(retired.mock.calls).toEqual([[["openclaw_plugin_reload_plugin_fresh"]]]);

    // resumeInstances(): the restored instance records again without a second register().
    live.instance.resume();
    live.metrics.gauge("depth").set({}, 4);
    expect(names(received)).toEqual([
      ["openclaw_plugin_reload_plugin_depth", 1],
      ["openclaw_plugin_reload_plugin_depth", 2],
      ["openclaw_plugin_reload_plugin_depth", 4],
    ]);
    await live.instance.dispose();
  });

  it("hands families to the replacement on a committed reload and retires only stale ones", async () => {
    const { received, retired } = subscribeAsExporter();
    const live = loadLive("swap-plugin", [
      { name: "depth", type: "gauge", help: "Depth" },
      { name: "level", type: "gauge", help: "Level" },
      { name: "old", type: "gauge", help: "Old" },
    ]);
    live.metrics.gauge("level").set({}, 1);
    const candidate = createApiWithRecord("swap-plugin", exporterEnabled);
    const next = registerInLoader(candidate, [
      { name: "depth", type: "gauge", help: "Depth" },
      // Relabelled across the reload.
      { name: "level", type: "gauge", help: "Level", labels: ["kind"] },
    ]);
    // Publication commits the replacement and retires the previous registry.
    markPluginRegistryActive(candidate.registry);
    markPluginRegistryRetired(live.registry);
    live.metrics.gauge("depth").set({}, 5);
    expect(retired).not.toHaveBeenCalled();

    next.gauge("level").set({ kind: "a" }, 2);
    expect(retired.mock.calls).toEqual([[["openclaw_plugin_swap_plugin_level"]]]);
    retired.mockClear();
    await live.instance.dispose();
    expect(retired.mock.calls).toEqual([[["openclaw_plugin_swap_plugin_old"]]]);
    next.gauge("depth").set({}, 6);
    expect(names(received)).toEqual([
      ["openclaw_plugin_swap_plugin_level", 1],
      ["openclaw_plugin_swap_plugin_level", 2],
      ["openclaw_plugin_swap_plugin_depth", 6],
    ]);
    retired.mockClear();
    await getPluginInstance(candidate.record)!.dispose();
    expect(retired.mock.calls).toEqual([
      [["openclaw_plugin_swap_plugin_depth", "openclaw_plugin_swap_plugin_level"]],
    ]);
  });

  it("delivers only from the published instance while an overlapping reload prepares", async () => {
    const { received, retired } = subscribeAsExporter();
    const overlap = { generationOverlap: true };
    const level = { name: "level", type: "gauge", help: "Level" } as const;
    // The replacement relabels "level", so any sample it delivered would reset the live series.
    const relabelled = { name: "level", type: "gauge", help: "Level", labels: ["kind"] } as const;
    const live = loadLive("overlap-plugin", [level], overlap);
    live.metrics.gauge("level").set({}, 1);

    // Prepare inside the real reload preparation scope: register() and a service start both record.
    const prepare = () => {
      const candidate = createApiWithRecord("overlap-plugin", exporterEnabled, overlap);
      return withPluginRegistryPreparationScope(candidate.registry, () => {
        let registered: ReturnType<NonNullable<typeof candidate.api.metrics>["register"]>;
        runPluginRegisterSyncInRegistry(
          (api) => {
            registered = api.metrics!.register({
              families: [relabelled, { name: "fresh", type: "gauge", help: "Fresh" }],
            });
            registered.gauge("level").set({ kind: "register" }, 9);
          },
          candidate.api,
          candidate.registry,
          candidate.record.id,
        );
        const metrics = registered!;
        // service.start() runs in the same scope before commitRuntime publishes the replacement.
        metrics.gauge("level").set({ kind: "service" }, 9);
        metrics.gauge("fresh").set({}, 9);
        return { ...candidate, metrics };
      });
    };

    // Failed replacement: the live series is untouched and keeps recording.
    const failed = prepare();
    live.metrics.gauge("level").set({}, 2);
    expect(retired).not.toHaveBeenCalled();
    markPluginRegistryRetired(failed.registry);
    await getPluginInstance(failed.record)!.dispose();
    expect(retired.mock.calls).toEqual([[["openclaw_plugin_overlap_plugin_fresh"]]]);
    live.metrics.gauge("level").set({}, 3);
    expect(names(received)).toEqual([
      ["openclaw_plugin_overlap_plugin_level", 1],
      ["openclaw_plugin_overlap_plugin_level", 2],
      ["openclaw_plugin_overlap_plugin_level", 3],
    ]);

    // Successful replacement: nothing switches until commit, then the replacement owns the name.
    retired.mockClear();
    received.mockClear();
    const next = prepare();
    live.metrics.gauge("level").set({}, 4);
    expect(retired).not.toHaveBeenCalled();
    markPluginRegistryActive(next.registry);
    markPluginRegistryRetired(live.registry);
    live.metrics.gauge("level").set({}, 5);
    await live.instance.dispose();
    // The old-shape series goes with the previous instance even before the replacement records.
    expect(retired.mock.calls).toEqual([[["openclaw_plugin_overlap_plugin_level"]]]);
    next.metrics.gauge("level").set({ kind: "a" }, 6);
    expect(retired).toHaveBeenCalledTimes(1);
    expect(received.mock.calls.map((call) => [call[0].name, call[1], call[2]])).toEqual([
      ["openclaw_plugin_overlap_plugin_level", {}, 4],
      ["openclaw_plugin_overlap_plugin_level", { kind: "a" }, 6],
    ]);
    await getPluginInstance(next.record)!.dispose();
  });

  it("does not let a disposed or older instance evict the live instance's families", async () => {
    const { received, retired } = subscribeAsExporter();
    const families = [{ name: "depth", type: "gauge", help: "Depth" }] as const;
    const stale = [{ name: "stale", type: "gauge", help: "Stale" }] as const;

    // Disposed: the registry binds teardown through the real instance lifecycle.
    const first = loadLive("zombie-plugin", families);
    await first.instance.dispose();
    expect(retired.mock.calls).toEqual([[["openclaw_plugin_zombie_plugin_depth"]]]);
    expect(() => first.api.metrics!.register({ families: stale })).toThrow("no longer current");

    // An older instance, still draining, registers after a newer one went live.
    const older = createApiWithRecord("zombie-plugin", exporterEnabled);
    const newer = loadLive("zombie-plugin", families);
    markPluginRegistryRetired(older.registry);
    expect(() => older.api.metrics!.register({ families: stale })).toThrow("no longer current");
    retired.mockClear();
    await getPluginInstance(older.record)!.dispose();
    expect(retired).not.toHaveBeenCalled();
    newer.metrics.gauge("depth").set({}, 4);
    expect(names(received)).toEqual([["openclaw_plugin_zombie_plugin_depth", 4]]);
    // Disposing the live instance still releases the live family.
    await newer.instance.dispose();
    expect(retired.mock.calls).toEqual([[["openclaw_plugin_zombie_plugin_depth"]]]);
  });
});
