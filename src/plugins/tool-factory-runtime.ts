/** Invokes current-context plugin tool factories and reports one assembly's timings. */
import type { AnyAgentTool } from "../agents/tools/common.js";
import { isInvalidConfigError } from "../config/io.invalid-config.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runWithTrackedCancellation } from "../shared/async-work-scope.js";
import { capturePluginLifecycleAuthority } from "./registry-lifecycle.js";
import type { PluginRegistry, PluginToolRegistration } from "./registry-types.js";
import {
  withPluginRuntimePluginScope,
  withPluginRuntimeRegistryScope,
} from "./runtime/gateway-request-scope.js";
import { copyPluginToolMeta } from "./tool-metadata.js";
import type { OpenClawPluginToolContext } from "./types.js";

type PluginToolFactoryTiming = {
  pluginId: string;
  names: string[];
  durationMs: number;
  elapsedMs: number;
  result: "array" | "error" | "null" | "single";
  resultCount: number;
  optional: boolean;
};

const log = createSubsystemLogger("plugins/tools");
const PLUGIN_TOOL_FACTORY_WARN_TOTAL_MS = 5_000;
const PLUGIN_TOOL_FACTORY_WARN_FACTORY_MS = 1_000;
const PLUGIN_TOOL_FACTORY_SUMMARY_LIMIT = 20;

function formatPluginToolFactoryTiming(timing: PluginToolFactoryTiming): string {
  const names = timing.names.length > 0 ? timing.names.join("|") : "-";
  return [
    `${timing.pluginId}:${timing.durationMs}ms@${timing.elapsedMs}ms`,
    `names=[${names}]`,
    `result=${timing.result}`,
    `count=${timing.resultCount}`,
    `optional=${String(timing.optional)}`,
  ].join(" ");
}

function runWithPluginToolScope<T>(
  entry: PluginToolRegistration,
  registry: PluginRegistry,
  run: () => T,
): T {
  return withPluginRuntimeRegistryScope(registry, () =>
    withPluginRuntimePluginScope(
      {
        pluginId: entry.pluginId,
        pluginSource: entry.source,
      },
      run,
    ),
  );
}

/** Callback availability is captured once; missing records must never become a fallback after removal. */
export function bindPluginToolCallbacks(
  entry: PluginToolRegistration,
  registry: PluginRegistry,
  tool: AnyAgentTool,
): AnyAgentTool {
  const record = registry.plugins.find((candidate) => candidate.id === entry.pluginId);
  const authority = capturePluginLifecycleAuthority(registry, record, { scopedRuntime: true });
  const invoke = <T>(run: () => T): T => {
    if (!authority?.()) {
      throw new Error(`Plugin "${entry.pluginId}" tool runtime is no longer active.`);
    }
    return runWithPluginToolScope(entry, registry, run);
  };
  const prepare = tool.prepareArguments;
  const callbacks = {
    execute: async (...args: Parameters<AnyAgentTool["execute"]>) =>
      invoke(() => {
        const [toolCallId, params, signal, onUpdate] = args;
        const execute = (executionSignal?: AbortSignal) =>
          tool.execute(toolCallId, params, executionSignal, onUpdate);
        return signal ? runWithTrackedCancellation(signal, execute) : execute();
      }),
    ...(prepare
      ? { prepareArguments: (args: unknown) => invoke(() => prepare.call(tool, args)) }
      : {}),
  };
  // A shadow preserves frozen factory objects and caller-defined fixed properties without violating Proxy invariants.
  const wrapped = new Proxy<AnyAgentTool>(Object.create(Object.getPrototypeOf(tool)), {
    get(target, key, receiver) {
      if (Object.hasOwn(target, key)) {
        return Reflect.get(target, key, receiver);
      }
      return Object.hasOwn(callbacks, key)
        ? Reflect.get(callbacks, key)
        : Reflect.get(tool, key, tool);
    },
    has: (target, key) => Reflect.has(target, key) || Reflect.has(tool, key),
    ownKeys: (target) => [...new Set([...Reflect.ownKeys(tool), ...Reflect.ownKeys(target)])],
    getOwnPropertyDescriptor(target, key) {
      const local = Reflect.getOwnPropertyDescriptor(target, key);
      if (local) {
        return local;
      }
      const source = Reflect.getOwnPropertyDescriptor(tool, key);
      if (!source) {
        return undefined;
      }
      if (Object.hasOwn(callbacks, key)) {
        return {
          configurable: true,
          enumerable: source.enumerable,
          writable: true,
          value: Reflect.get(callbacks, key),
        };
      }
      return "value" in source
        ? { ...source, configurable: true }
        : {
            ...source,
            configurable: true,
            get: source.get ? () => Reflect.get(tool, key, tool) : undefined,
            set: source.set
              ? (value) => {
                  Reflect.set(tool, key, value, tool);
                }
              : undefined,
          };
    },
    set: (target, key, value, receiver) =>
      Object.hasOwn(target, key)
        ? Reflect.set(target, key, value, receiver)
        : Reflect.set(tool, key, value, tool),
    deleteProperty: (target, key) =>
      Object.hasOwn(target, key)
        ? Reflect.deleteProperty(target, key)
        : Reflect.deleteProperty(tool, key),
    preventExtensions: () => false,
  });
  copyPluginToolMeta(tool, wrapped);
  return wrapped;
}

export function createPluginToolFactoryResolver(logError: (message: string) => void) {
  const factoryTimingStartedAt = Date.now();
  const factoryTimings: PluginToolFactoryTiming[] = [];
  const formatTimingSummary = (totalMs: number): string => {
    const ranked = factoryTimings
      .toSorted(
        (left, right) =>
          right.durationMs - left.durationMs || left.pluginId.localeCompare(right.pluginId),
      )
      .slice(0, PLUGIN_TOOL_FACTORY_SUMMARY_LIMIT);
    const omitted = factoryTimings.length - ranked.length;
    const factories = ranked.map(formatPluginToolFactoryTiming).join(", ");
    return [
      "[trace:plugin-tools] factory timings",
      `totalMs=${totalMs}`,
      `factoryCount=${factoryTimings.length}`,
      `shown=${ranked.length}`,
      `omitted=${omitted}`,
      `factories=${factories}`,
    ].join(" ");
  };
  return {
    resolve(
      entry: PluginToolRegistration,
      ctx: OpenClawPluginToolContext,
      declaredNames: string[],
      registry: PluginRegistry,
    ) {
      let resolved: ReturnType<PluginToolRegistration["factory"]> = null;
      let failed = false;
      const factoryStartedAt = Date.now();
      try {
        resolved = runWithPluginToolScope(entry, registry, () => entry.factory(ctx));
      } catch (err) {
        failed = true;
        // Only the config producer can confirm its diagnostic was emitted;
        // unlogged or wrapped tagged errors still need this resolver's report.
        if (!(isInvalidConfigError(err) && err.diagnosticEmitted)) {
          logError(`plugin tool failed (${entry.pluginId}): ${formatErrorMessage(err)}`);
        }
      }
      const factoryEndedAt = Date.now();
      factoryTimings.push({
        pluginId: entry.pluginId,
        names: declaredNames,
        durationMs: Math.max(0, factoryEndedAt - factoryStartedAt),
        elapsedMs: Math.max(0, factoryEndedAt - factoryTimingStartedAt),
        result: failed
          ? "error"
          : !resolved
            ? "null"
            : Array.isArray(resolved)
              ? "array"
              : "single",
        resultCount: failed || !resolved ? 0 : Array.isArray(resolved) ? resolved.length : 1,
        optional: entry.optional,
      });
      return { resolved, failed };
    },
    report() {
      const last = factoryTimings.at(-1);
      if (last) {
        if (
          last.elapsedMs >= PLUGIN_TOOL_FACTORY_WARN_TOTAL_MS ||
          factoryTimings.some((timing) => timing.durationMs >= PLUGIN_TOOL_FACTORY_WARN_FACTORY_MS)
        ) {
          log.warn(formatTimingSummary(last.elapsedMs));
        } else if (log.isEnabled("trace")) {
          log.trace(formatTimingSummary(last.elapsedMs));
        }
      }
    },
  };
}
