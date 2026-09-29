import { createAgentEventBridge, type AgentEventDeliveryStartOrder } from "./agent-event-bridge.js";

type AssistantTextDelivery =
  | { text: string; completed: false }
  | { text: string; completed: true; assistantMessageIndex: number };

export function createAssistantTextBridge(params: {
  runId: string;
  suppressed?: boolean;
  deliver?: (text: string) => Promise<boolean | void>;
  deliverCompleted?: (text: string, assistantMessageIndex: number) => Promise<void>;
  startOrder?: AgentEventDeliveryStartOrder;
}) {
  let lastText: string | undefined;
  return createAgentEventBridge<AssistantTextDelivery>({
    runId: params.runId,
    suppressed: params.suppressed,
    startOrder: params.startOrder,
    waitForEarlierDeliveries: (payload) => payload.completed,
    deliver: async (payload) => {
      if (payload.completed) {
        await params.deliverCompleted?.(payload.text, payload.assistantMessageIndex);
      } else {
        await params.deliver?.(payload.text);
      }
    },
    read: (evt) => {
      if (evt.stream !== "assistant") {
        return undefined;
      }
      if (
        typeof evt.data.completedText === "string" &&
        typeof evt.data.assistantMessageIndex === "number"
      ) {
        return {
          text: evt.data.completedText,
          completed: true,
          assistantMessageIndex: evt.data.assistantMessageIndex,
        };
      }
      const text = typeof evt.data.text === "string" ? evt.data.text : undefined;
      if (text === undefined || text === lastText) {
        return undefined;
      }
      lastText = text;
      return { text, completed: false };
    },
  });
}
