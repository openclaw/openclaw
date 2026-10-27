import type { ProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { AsyncContext } from "../shared/async-context.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// Source tools and compiled SDK consumers must observe the same invocation.
const executionModel = resolveGlobalSingleton(
  Symbol.for("openclaw.agentToolExecutionModel"),
  () => new AsyncContext<Readonly<ProviderModelRef>>(Symbol("agentToolExecutionModel")),
);

/** Model facts for derived tool output, never caller or execution authority. */
export function getAgentToolExecutionModel(): Readonly<ProviderModelRef> | undefined {
  return executionModel.getStore();
}

/** Host-only binding; the original executor retains all of its source guards. */
export function runWithAgentToolExecutionModel<T>(
  model: Readonly<ProviderModelRef>,
  run: () => T,
): T {
  return executionModel.run(model, run);
}
