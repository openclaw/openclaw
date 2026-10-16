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
    ? ` sessionKey=${JSON.stringify(context.sessionKey ?? "unknown")} runId=${JSON.stringify(context.runId ?? "unknown")} requestId=${JSON.stringify(context.requestId)} requestNumber=${context.requestId.slice(context.requestId.lastIndexOf(":") + 1)}`
    : "";
}
