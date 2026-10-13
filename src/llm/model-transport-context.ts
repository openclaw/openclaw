import { AsyncLocalStorage } from "node:async_hooks";

type ModelTransportContext = {
  sessionKey?: string;
  runId?: string;
  requestId: string;
};

const modelTransportContext = new AsyncLocalStorage<ModelTransportContext>();

export function withModelTransportContext<T>(context: ModelTransportContext, run: () => T): T {
  return modelTransportContext.run(context, run);
}

export function formatModelTransportContext(): string {
  const context = modelTransportContext.getStore();
  return context
    ? ` sessionKey=${context.sessionKey ?? "unknown"} runId=${context.runId ?? "unknown"} requestId=${context.requestId} requestNumber=${context.requestId.slice(context.requestId.lastIndexOf(":") + 1)}`
    : "";
}
