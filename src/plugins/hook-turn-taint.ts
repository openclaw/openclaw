import type { PluginHookName } from "./hook-types.js";

const turnTaintHooks = new Set<PluginHookName>([
  "before_prompt_build",
  "llm_input",
  "llm_output",
  "before_agent_finalize",
  "agent_end",
  "before_compaction",
  "after_compaction",
]);

/** Project the runtime snapshot at delivery, not onto unrelated users of the same context. */
export function projectHookTurnTaint<T extends object>(name: PluginHookName, ctx: T): T {
  if (turnTaintHooks.has(name)) {
    if ("turnTainted" in ctx && typeof ctx.turnTainted === "boolean") {
      return ctx;
    }
    return { ...ctx, turnTainted: "unknown" };
  }
  if ("turnTainted" in ctx) {
    const { turnTainted: _omitted, ...rest } = ctx;
    // SAFETY: Unrelated hook contexts do not declare turnTainted; all their declared fields are preserved.
    return rest as T;
  }
  return ctx;
}
