import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import type { CanvasDocumentViewResult } from "@openclaw/gateway-protocol";
import type { ApplicationContext } from "../app/context.ts";
import { WIDGET_LOAD_TIMEOUT_MS } from "../lib/widget-sandbox-host.ts";

type WidgetClient = NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;

export type CanvasWidgetViewBinding = {
  client: WidgetClient;
  generation: number;
  docId: string;
  sessionKey: string;
  operatorRead: boolean;
};

const pendingViews = new WeakMap<
  WidgetClient,
  {
    generation: number;
    requests: Map<string, { result: Promise<CanvasDocumentViewResult>; terminal: boolean }>;
  }
>();

export function isTerminalCanvasViewError(error: unknown): boolean {
  return (
    error instanceof GatewayProtocolRequestError &&
    error.gatewayCode === "UNAVAILABLE" &&
    !error.retryable
  );
}

function canvasViewRequestKey(binding: CanvasWidgetViewBinding): string {
  return `${binding.sessionKey}\0${binding.docId}\0${binding.operatorRead}`;
}

export function forgetPendingCanvasView(binding: CanvasWidgetViewBinding | undefined): void {
  if (!binding) {
    return;
  }
  const pending = pendingViews.get(binding.client);
  if (pending?.generation === binding.generation) {
    const key = canvasViewRequestKey(binding);
    if (!pending.requests.get(key)?.terminal) {
      pending.requests.delete(key);
    }
  }
}

export function loadCanvasView(
  binding: CanvasWidgetViewBinding,
): Promise<CanvasDocumentViewResult> {
  let pending = pendingViews.get(binding.client);
  if (!pending || pending.generation !== binding.generation) {
    pending = { generation: binding.generation, requests: new Map() };
    pendingViews.set(binding.client, pending);
  }
  const requestKey = canvasViewRequestKey(binding);
  const existing = pending.requests.get(requestKey);
  if (existing) {
    return existing.result;
  }
  const request = binding.client.request<CanvasDocumentViewResult>(
    "canvas.document.view",
    {
      docId: binding.docId,
      ...(!binding.operatorRead && binding.sessionKey ? { sessionKey: binding.sessionKey } : {}),
    },
    { timeoutMs: WIDGET_LOAD_TIMEOUT_MS },
  );
  // Retain terminal misses through row remounts until reload/reconnection.
  // Successful HTML stays with the mounted view, never in this request owner.
  const requests = pending.requests;
  const entry = { result: request, terminal: false };
  requests.set(requestKey, entry);
  void request
    .catch((error: unknown) => {
      entry.terminal = isTerminalCanvasViewError(error);
    })
    .finally(() => {
      if (!entry.terminal && requests.get(requestKey) === entry) {
        requests.delete(requestKey);
      }
    });
  return request;
}
