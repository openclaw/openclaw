import { AsyncContext } from "../shared/async-context.js";

type ModelTransportContext = {
  sessionKey?: string;
  runId?: string;
  requestId: string;
  priority?: "interactive" | "background";
  onRateLimitWait?: (retryAt: number) => () => void;
};

const modelTransportContext = new AsyncContext<ModelTransportContext>(
  Symbol("modelTransportContext"),
);

export function withModelTransportContext<T>(context: ModelTransportContext, run: () => T): T {
  return modelTransportContext.run(context, run);
}

export function getModelTransportContext(): ModelTransportContext | undefined {
  return modelTransportContext.getStore();
}

export function formatModelTransportContext(
  requestIdLabel: "requestId" | "clientRequestId" = "requestId",
): string {
  const context = modelTransportContext.getStore();
  return context
    ? ` sessionKey=${JSON.stringify(context.sessionKey ?? "unknown")} runId=${JSON.stringify(context.runId ?? "unknown")} ${requestIdLabel}=${JSON.stringify(context.requestId)} requestNumber=${context.requestId.slice(context.requestId.lastIndexOf(":") + 1)}`
    : "";
}
