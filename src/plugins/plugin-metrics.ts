import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PluginLogger } from "./types.js";

/** One metric family a plugin declares up front; label names cannot change later. */
export type PluginMetricFamilyDeclaration =
  | { name: string; type: "counter" | "gauge"; help: string; labels?: readonly string[] }
  | {
      name: string;
      type: "histogram";
      help: string;
      labels?: readonly string[];
      /** Finite, strictly ascending upper bounds; `+Inf` is added by the exporter. */
      buckets: readonly number[];
    };

export type PluginMetricLabels = Readonly<Record<string, string>>;

/** Recorders for the families from one `register()` call. */
export type PluginMetrics = {
  counter: (name: string) => { inc: (labels?: PluginMetricLabels, amount?: number) => void };
  gauge: (name: string) => { set: (labels: PluginMetricLabels, value: number) => void };
  histogram: (name: string) => { observe: (labels: PluginMetricLabels, value: number) => void };
};

/** Present only when a diagnostics exporter plugin is enabled; values reach listening exporters. */
export type PluginMetricsApi = {
  /** Families are exported as `openclaw_plugin_<plugin id>_<name>`. Throws on invalid input. */
  register: (params: { families: readonly PluginMetricFamilyDeclaration[] }) => PluginMetrics;
};

/** Host-admitted family as exporters see it. */
export type PluginMetricFamily = Readonly<{
  /** Full exported name, including the host-owned plugin prefix. */
  name: string;
  type: "counter" | "gauge" | "histogram";
  help: string;
  labels: readonly string[];
  buckets?: readonly number[];
}>;

/** Synchronous exporter callbacks; `labels` is borrowed until `record` returns. */
export type PluginMetricsListener = {
  record: (family: PluginMetricFamily, labels: PluginMetricLabels, value: number) => void;
  /** Names no live registration declares, or whose shape changed; drop their series and headers. */
  retire: (names: readonly string[]) => void;
};

/** Families from one `register()` call, live until replaced or its instance is disposed. */
type Registration = {
  pluginId: string;
  /** Declared name to admitted family. */
  families: ReadonlyMap<string, PluginMetricFamily>;
  /** Plugin lifecycle authority captured at registration; false while the instance is not current. */
  isCurrent: () => boolean;
  /** True only while this instance is the published one; gates sample delivery. */
  isPublished: () => boolean;
};

const state = resolveGlobalSingleton(Symbol.for("openclaw.pluginMetrics"), () => ({
  listeners: new Set<PluginMetricsListener>(),
  registrations: new Set<Registration>(),
  /** Family shape exporters last received per exported name. */
  exported: new Map<string, PluginMetricFamily>(),
}));

export function onPluginMetrics(listener: PluginMetricsListener): () => void {
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

const METRIC_NAME = /^[a-z][a-z0-9_]*$/u;
// Same low-cardinality policy as diagnostic reason codes; other values export as "other".
const LABEL_VALUE = /^[A-Za-z0-9_.:-]{1,120}$/u;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/u;

function notifyRetired(names: readonly string[]): void {
  if (names.length === 0) {
    return;
  }
  for (const listener of state.listeners) {
    try {
      listener.retire(names);
    } catch {
      // An exporter cannot break plugin registration or disposal.
    }
  }
}

/**
 * Retire `released` families that no remaining registration of `pluginId` still declares, or
 * that every remaining holder declares with a different shape than the exporter last received.
 */
function retireUnheld(pluginId: string, released: Iterable<PluginMetricFamily>): void {
  const held = new Map<string, PluginMetricFamily[]>();
  for (const registration of state.registrations) {
    if (registration.pluginId === pluginId) {
      for (const family of registration.families.values()) {
        held.set(family.name, [...(held.get(family.name) ?? []), family]);
      }
    }
  }
  const names: string[] = [];
  for (const family of released) {
    const holders = held.get(family.name);
    const shown = state.exported.get(family.name);
    const kept =
      holders !== undefined &&
      (shown === undefined || holders.some((holder) => sameShape(holder, shown)));
    if (!kept && !names.includes(family.name)) {
      names.push(family.name);
      state.exported.delete(family.name);
    }
  }
  notifyRetired(names);
}

/** Exposition names a family occupies; histograms also own their derived series names. */
function claimedNames(family: PluginMetricFamily): readonly string[] {
  return family.type === "histogram"
    ? [family.name, `${family.name}_bucket`, `${family.name}_sum`, `${family.name}_count`]
    : [family.name];
}

function sameShape(a: PluginMetricFamily, b: PluginMetricFamily): boolean {
  return (
    a.type === b.type &&
    a.help === b.help &&
    a.labels.join(",") === b.labels.join(",") &&
    (a.buckets ?? []).join(",") === (b.buckets ?? []).join(",")
  );
}

function pluginMetricPrefix(pluginId: string): string {
  const id = pluginId.toLowerCase().replace(/[^a-z0-9_]+/gu, "_");
  return `openclaw_plugin_${id.replace(/^_+|_+$/gu, "")}_`;
}

function admitFamily(prefix: string, input: PluginMetricFamilyDeclaration): PluginMetricFamily {
  const fail = (message: string): never => {
    throw new Error(`plugin metrics: ${String(input?.name)}: ${message}`);
  };
  const { name, type, help } = input ?? {};
  if (typeof name !== "string" || !METRIC_NAME.test(name)) {
    fail("name must match [a-z][a-z0-9_]*");
  }
  if (type !== "counter" && type !== "gauge" && type !== "histogram") {
    fail("type must be counter, gauge or histogram");
  }
  if (type === "counter" && !name.endsWith("_total")) {
    fail("counter names must end in _total");
  }
  if (typeof help !== "string" || !help.trim()) {
    fail("help is required");
  }
  const labels = [...(input.labels ?? [])];
  for (const label of labels) {
    if (
      typeof label !== "string" ||
      !LABEL_NAME.test(label) ||
      label.startsWith("__") ||
      label === "le"
    ) {
      fail(`invalid label name ${String(label)}`);
    }
  }
  if (new Set(labels).size !== labels.length) {
    fail("label names must be unique");
  }
  let buckets: number[] | undefined;
  if (input.type === "histogram") {
    buckets = Array.isArray(input.buckets) ? [...input.buckets] : [];
    if (
      buckets.length === 0 ||
      buckets.some(
        (bound, index) =>
          typeof bound !== "number" ||
          !Number.isFinite(bound) ||
          (index > 0 && bound <= buckets![index - 1]!),
      )
    ) {
      fail("histogram buckets must be finite and strictly ascending");
    }
  }
  return Object.freeze({
    name: `${prefix}${name}`,
    type,
    help,
    labels: Object.freeze(labels.toSorted()),
    ...(buckets ? { buckets: Object.freeze(buckets) } : {}),
  });
}

export type PluginMetricsApiOptions = {
  /** Binds teardown to the plugin instance; may throw when the instance is already retiring. */
  onDispose?: (dispose: () => void) => void;
  /**
   * Mints the plugin lifecycle authority for this instance, or undefined when it cannot act.
   * Omitted only by standalone callers, which are always current.
   */
  captureAuthority?: () => (() => boolean) | undefined;
  /**
   * True while this instance is the published one. Registration (including during reload
   * preparation) only admits declarations; samples reach exporters only while this holds.
   */
  isPublished?: () => boolean;
};

/**
 * Build one plugin instance's `api.metrics`; families are admitted once and passed by reference.
 * Instances of the same plugin may hold the same family names side by side (for example during
 * a reload); samples reach exporters only while the recording instance is published, and a
 * family is retired only when no remaining registration of the plugin declares it.
 */
export function createPluginMetricsApi(
  pluginId: string,
  logger: PluginLogger,
  options: PluginMetricsApiOptions = {},
): PluginMetricsApi {
  const prefix = pluginMetricPrefix(pluginId);
  let registration: Registration | undefined;
  let disposeBound = false;
  let disposed = false;
  return {
    register({ families }) {
      const isCurrent = disposed
        ? undefined
        : options.captureAuthority
          ? options.captureAuthority()
          : () => true;
      if (!isCurrent) {
        throw new Error(`plugin metrics: ${pluginId} metrics API is no longer current`);
      }
      if (!Array.isArray(families) || families.length === 0) {
        throw new Error("plugin metrics: families must be a non-empty array");
      }
      // Every exposition name in use, including histogram _bucket/_sum/_count series.
      const claims = new Map<string, { pluginId: string; family: PluginMetricFamily }>();
      for (const other of state.registrations) {
        if (other !== registration) {
          for (const family of other.families.values()) {
            for (const name of claimedNames(family)) {
              claims.set(name, { pluginId: other.pluginId, family });
            }
          }
        }
      }
      const admitted = new Map<string, PluginMetricFamily>();
      for (const declaration of families) {
        const family = admitFamily(prefix, declaration);
        if (admitted.has(declaration.name)) {
          throw new Error(`plugin metrics: ${family.name} is already registered`);
        }
        for (const name of claimedNames(family)) {
          const claim = claims.get(name);
          // Another instance of this plugin may hold the same family; nothing else may overlap.
          if (claim && !(claim.pluginId === pluginId && claim.family.name === family.name)) {
            throw new Error(
              claim.family.name === family.name
                ? `plugin metrics: ${family.name} is already registered`
                : `plugin metrics: ${family.name} conflicts with ${claim.family.name}`,
            );
          }
        }
        for (const name of claimedNames(family)) {
          claims.set(name, { pluginId, family });
        }
        admitted.set(declaration.name, family);
      }
      if (!disposeBound && options.onDispose) {
        // Throws when the instance is already retiring, before any state changes.
        options.onDispose(() => {
          disposed = true;
          const owned = registration;
          registration = undefined;
          if (owned && state.registrations.delete(owned)) {
            retireUnheld(pluginId, owned.families.values());
          }
        });
        disposeBound = true;
      }
      // Re-registration by this instance replaces its own families only; other instances of
      // the plugin keep theirs until their own disposal.
      const previous = registration;
      const current: Registration = {
        pluginId,
        families: admitted,
        isCurrent,
        isPublished: options.isPublished ?? (() => true),
      };
      registration = current;
      state.registrations.add(current);
      if (previous && state.registrations.delete(previous)) {
        retireUnheld(pluginId, previous.families.values());
      }
      const warned = new Set<string>();
      const lookup = (name: string, type: PluginMetricFamily["type"]) => {
        const family = admitted.get(name);
        if (family?.type !== type) {
          throw new Error(`plugin metrics: no ${type} named ${name} was registered`);
        }
        return family;
      };
      const publish = (family: PluginMetricFamily, labels: PluginMetricLabels, value: number) => {
        if (
          state.listeners.size === 0 ||
          !state.registrations.has(current) ||
          !current.isCurrent() ||
          !current.isPublished()
        ) {
          return;
        }
        const keys = Object.keys(labels);
        if (
          keys.length !== family.labels.length ||
          family.labels.some((key) => typeof labels[key] !== "string")
        ) {
          if (!warned.has(family.name)) {
            warned.add(family.name);
            logger.warn(
              `[plugins] ${pluginId}: dropped ${family.name} sample; labels must be exactly [${family.labels.join(", ")}] with string values`,
            );
          }
          return;
        }
        let safeLabels = labels;
        for (const key of keys) {
          if (!LABEL_VALUE.test(labels[key]!)) {
            safeLabels = Object.fromEntries(
              keys.map((name) => [name, LABEL_VALUE.test(labels[name]!) ? labels[name]! : "other"]),
            );
            break;
          }
        }
        const shown = state.exported.get(family.name);
        if (shown !== family) {
          // A reload that changed this family's type, help, labels or buckets starts it clean.
          if (shown && !sameShape(shown, family)) {
            notifyRetired([family.name]);
          }
          state.exported.set(family.name, family);
        }
        for (const listener of state.listeners) {
          try {
            listener.record(family, safeLabels, value);
          } catch {
            // An exporter cannot break the plugin that records a metric.
          }
        }
      };
      return {
        counter: (name) => {
          const family = lookup(name, "counter");
          return { inc: (labels = {}, amount = 1) => publish(family, labels, amount) };
        },
        gauge: (name) => {
          const family = lookup(name, "gauge");
          return { set: (labels, value) => publish(family, labels, value) };
        },
        histogram: (name) => {
          const family = lookup(name, "histogram");
          return { observe: (labels, value) => publish(family, labels, value) };
        },
      };
    },
  };
}
