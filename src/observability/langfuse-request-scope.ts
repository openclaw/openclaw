import { AsyncLocalStorage } from "node:async_hooks";
import type { LangfuseHandle } from "./langfuse.js";

export type LangfuseRequestScope = {
  trace: LangfuseHandle;
  traceId?: string;
  requestName: string;
  metadata?: Record<string, unknown>;
};

const LANGFUSE_REQUEST_SCOPE_KEY: unique symbol = Symbol.for(
  "openclaw.observability.langfuseRequestScope",
);

const langfuseRequestScope = (() => {
  const globalState = globalThis as typeof globalThis & {
    [LANGFUSE_REQUEST_SCOPE_KEY]?: AsyncLocalStorage<LangfuseRequestScope>;
  };
  const existing = globalState[LANGFUSE_REQUEST_SCOPE_KEY];
  if (existing) {
    return existing;
  }
  const created = new AsyncLocalStorage<LangfuseRequestScope>();
  globalState[LANGFUSE_REQUEST_SCOPE_KEY] = created;
  return created;
})();

export function withLangfuseRequestScope<T>(scope: LangfuseRequestScope, run: () => T): T {
  return langfuseRequestScope.run(scope, run);
}

export function getLangfuseRequestScope(): LangfuseRequestScope | undefined {
  return langfuseRequestScope.getStore();
}
