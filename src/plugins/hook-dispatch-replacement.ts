import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
// One hook dispatch's view of plugins a reload replaced while it was dispatching.
import type { PluginHookName, PluginHookRegistration } from "./hook-types.js";
import { isPluginReloadingError } from "./plugin-replacement-retry.js";

/** Settles in place of a handler result once a reload that refused the handler finishes. */
export const HOOK_REPLACED: unique symbol = Symbol("openclaw.hookReplaced");

/**
 * Tracks which plugins one dispatch already waited out a reload for. The dispatch
 * loop, not this class, invokes replacement registrations, so it reruns its own
 * admission checks and per-handler context, and an expired dispatch starts no
 * late plugin work.
 */
export class HookDispatchSelection<K extends PluginHookName> {
  private readonly replaced = new Set<string>();

  /** `reselect` must apply the dispatch's own eligibility and authority filters. */
  constructor(
    private readonly dispatched: readonly PluginHookRegistration<K>[],
    private readonly reselect: () => readonly PluginHookRegistration<K>[],
  ) {}

  /**
   * The registration to invoke for a dispatched hook: the hook itself, or, once
   * this dispatch waited out its plugin's reload, the same plugin's registration
   * at the same position in the current registry. Undefined when the
   * replacement dropped it.
   */
  current(hook: PluginHookRegistration<K>): PluginHookRegistration<K> | undefined {
    if (!this.replaced.has(hook.pluginId)) {
      return hook;
    }
    const position = this.dispatched
      .filter((entry) => entry.pluginId === hook.pluginId)
      .indexOf(hook);
    return this.reselect().filter((entry) => entry.pluginId === hook.pluginId)[position];
  }

  /**
   * Runs one handler invocation. The first reload refusal for a plugin settles
   * to HOOK_REPLACED after that reload finishes; a refusal of a registration
   * already reselected after a reload propagates like any handler failure.
   * A synchronous result settles without extra turns, so per-handler context
   * revoked on settlement closes as soon as the handler returns.
   */
  invoke<T>(
    registration: PluginHookRegistration<K>,
    run: () => T | PromiseLike<T>,
  ): Promise<T | typeof HOOK_REPLACED> {
    const replace = (error: unknown) => this.awaitReplacement(registration, error);
    try {
      const result = run();
      return isPromiseLike(result)
        ? Promise.resolve(result).then(undefined, replace)
        : Promise.resolve(result);
    } catch (error) {
      return replace(error);
    }
  }

  private async awaitReplacement(
    registration: PluginHookRegistration<K>,
    error: unknown,
  ): Promise<typeof HOOK_REPLACED> {
    if (!isPluginReloadingError(error) || this.replaced.has(registration.pluginId)) {
      throw error;
    }
    await error.replacement;
    this.replaced.add(registration.pluginId);
    return HOOK_REPLACED;
  }
}
