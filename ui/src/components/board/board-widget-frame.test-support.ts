import { onTestFinished } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";

export function widgetBridge(
  options: {
    onInit?: (data: { ticket: string; controlUiBaseUrl?: string }) => void;
  } = {},
) {
  const channel = new MessageChannel();
  onTestFinished(() => channel.port2.close());
  const initialized = createDeferred();
  channel.port2.addEventListener("message", (event) => {
    if (event.data.type === "openclaw:widget-host-init") {
      channel.port2.postMessage({
        type: "openclaw:widget-host-init-ack",
        ticket: event.data.ticket,
      });
      initialized.resolve();
      options.onInit?.(event.data);
    }
  });
  channel.port2.start();
  return {
    port: channel.port1,
    initialized: initialized.promise,
    send(id: string, method: string, params: object, ticket = "ticket") {
      const response = createDeferred<Record<string, unknown>>();
      const receive = (event: MessageEvent) => {
        if (event.data.type === "openclaw:widget-bridge-response" && event.data.id === id) {
          channel.port2.removeEventListener("message", receive);
          response.resolve(event.data);
        }
      };
      channel.port2.addEventListener("message", receive);
      channel.port2.postMessage({
        type: "openclaw:widget-bridge-request",
        id,
        method,
        params,
        ticket,
      });
      return response.promise;
    },
  };
}
