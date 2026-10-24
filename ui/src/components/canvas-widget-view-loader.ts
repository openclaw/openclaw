import type { GatewaySessionMessageSubscription } from "@openclaw/gateway-client/browser";
import type { CanvasDocumentViewResult } from "@openclaw/gateway-protocol";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayEventFrame } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import { formatUiError } from "../lib/format-error.ts";
import { WIDGET_LOAD_TIMEOUT_MS } from "../lib/widget-sandbox-host.ts";

type WidgetClient = NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
export type CanvasWidgetViewBinding = {
  client: WidgetClient;
  generation: number;
  docId: string;
  sessionKey: string;
  operatorRead: boolean;
};

export function isCanvasWidgetLoadRetryEvent(
  event: GatewayEventFrame,
  binding: CanvasWidgetViewBinding,
): boolean {
  const payload = asOptionalRecord(event.payload);
  if (binding.operatorRead || payload?.sessionKey !== binding.sessionKey) {
    return false;
  }
  const message = asOptionalRecord(payload.message);
  return (
    (event.event === "session.message" &&
      message?.role === "toolResult" &&
      message.toolName === "show_widget") ||
    (event.event === "chat" &&
      (payload.state === "final" || payload.state === "aborted" || payload.state === "error"))
  );
}

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

function forgetPendingCanvasView(binding: CanvasWidgetViewBinding | undefined): void {
  if (!binding) {
    return;
  }
  const pending = pendingViews.get(binding.client);
  if (pending?.generation === binding.generation) {
    pending.requests.delete(canvasViewRequestKey(binding));
  }
}

function loadCanvasView(binding: CanvasWidgetViewBinding): Promise<CanvasDocumentViewResult> {
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

export function createCanvasWidgetViewLoader(
  sessions: Pick<ApplicationContext["sessions"], "subscribeMessages" | "unsubscribeMessages">,
) {
  let interest:
    | { binding: CanvasWidgetViewBinding; ready: Promise<GatewaySessionMessageSubscription> }
    | undefined;

  function release(): void {
    const previous = interest;
    interest = undefined;
    if (previous) {
      void previous.ready
        .then(
          (subscription) => sessions.unsubscribeMessages(subscription),
          () => undefined,
        )
        .catch((error: unknown) => {
          console.warn("[canvas] Failed to release message subscription:", formatUiError(error));
        });
    }
  }

  async function load(binding: CanvasWidgetViewBinding, isCurrent: () => boolean) {
    if (!binding.operatorRead && binding.sessionKey) {
      if (
        interest &&
        (interest.binding.client !== binding.client ||
          interest.binding.generation !== binding.generation ||
          interest.binding.sessionKey !== binding.sessionKey)
      ) {
        release();
      }
      // Admission precedes the lookup; an unloaded widget keeps its own exact
      // interest across retries and parking, independently of its chat pane.
      const current = (interest ??= {
        binding,
        ready: sessions.subscribeMessages(binding.sessionKey),
      });
      try {
        await current.ready;
      } catch (error) {
        if (interest === current) {
          interest = undefined;
        }
        throw error;
      }
    }
    return isCurrent() ? loadCanvasView(binding) : undefined;
  }

  return { load, release, forget: forgetPendingCanvasView };
}
