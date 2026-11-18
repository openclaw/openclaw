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
    requests: Map<string, Promise<CanvasDocumentViewResult>>;
  }
>();

function canvasViewRequestKey(binding: CanvasWidgetViewBinding): string {
  return `${binding.sessionKey}\0${binding.docId}\0${binding.operatorRead}`;
}

export function forgetPendingCanvasView(binding: CanvasWidgetViewBinding | undefined): void {
  if (!binding) {
    return;
  }
  const pending = pendingViews.get(binding.client);
  if (pending?.generation === binding.generation) {
    pending.requests.delete(canvasViewRequestKey(binding));
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
    return existing;
  }
  const request = binding.client.request<CanvasDocumentViewResult>(
    "canvas.document.view",
    {
      docId: binding.docId,
      ...(!binding.operatorRead && binding.sessionKey ? { sessionKey: binding.sessionKey } : {}),
    },
    { timeoutMs: WIDGET_LOAD_TIMEOUT_MS },
  );
  // Canvas also supports replacing a named document. Share concurrent reads,
  // but only the mounted view retains bytes; a remount revalidates the source.
  if (pending.requests.size < 32) {
    const requests = pending.requests;
    requests.set(requestKey, request);
    void request
      .finally(() => {
        if (requests.get(requestKey) === request) {
          requests.delete(requestKey);
        }
      })
      .catch(() => {});
  }
  return request;
}
