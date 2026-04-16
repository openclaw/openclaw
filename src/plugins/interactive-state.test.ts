import { afterEach, describe, expect, it } from "vitest";
import { resolveGlobalDedupeCache } from "../infra/dedupe.js";
import { clearPluginInteractiveHandlersState } from "./interactive-state.js";

const PLUGIN_INTERACTIVE_STATE_KEY = Symbol.for("openclaw.pluginInteractiveState");

describe("clearPluginInteractiveHandlersState (#67525)", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, PLUGIN_INTERACTIVE_STATE_KEY);
  });

  it("repairs legacy singletons missing callbackDedupe before clearing", () => {
    (globalThis as Record<PropertyKey, unknown>)[PLUGIN_INTERACTIVE_STATE_KEY] = {
      interactiveHandlers: new Map(),
      inflightCallbackDedupe: new Set<string>(),
    };

    expect(() => clearPluginInteractiveHandlersState()).not.toThrow();
  });

  it("repairs legacy singletons missing inflightCallbackDedupe before clearing", () => {
    (globalThis as Record<PropertyKey, unknown>)[PLUGIN_INTERACTIVE_STATE_KEY] = {
      interactiveHandlers: new Map(),
      callbackDedupe: resolveGlobalDedupeCache(Symbol.for("openclaw.pluginInteractiveCallbackDedupe"), {
        ttlMs: 5 * 60_000,
        maxSize: 4096,
      }),
    };

    expect(() => clearPluginInteractiveHandlersState()).not.toThrow();
  });
});
