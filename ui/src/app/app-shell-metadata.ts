import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayEventFrame } from "../api/gateway.ts";
import {
  invalidateChatMetadataForSessionEvent,
  invalidateChatMetadataStore,
} from "../lib/chat/chat-metadata-cache.ts";
import {
  invalidateModelAuthStatusRequests,
  modelAuthEventInvalidates,
} from "../lib/model-auth-request-state.ts";
import { modelCatalogEventInvalidation } from "../lib/model-catalog-cache.ts";
import type { ApplicationContext } from "./context.ts";

export function handleShellMetadataEvent(
  context: ApplicationContext | undefined,
  event: GatewayEventFrame,
): void {
  const client = context?.gateway?.snapshot.client;
  if (client && event.event === "sessions.changed") {
    invalidateChatMetadataForSessionEvent(client, event.payload, {
      hello: context?.gateway.snapshot.hello,
      agentsList: context?.agents.state.agentsList,
    });
  }
  const modelInvalidation = modelCatalogEventInvalidation(event);
  const metadataChange =
    event.event === "chat.metadata.changed" ? asNullableRecord(event.payload) : undefined;
  const commandsChanged = metadataChange?.commandsChanged !== false;
  if (client && modelAuthEventInvalidates(event)) {
    invalidateModelAuthStatusRequests(
      client,
      typeof metadataChange?.agentId === "string" ? metadataChange.agentId : undefined,
    );
  }
  if (
    client &&
    (modelInvalidation || (event.event === "chat.metadata.changed" && commandsChanged))
  ) {
    invalidateChatMetadataStore(
      client,
      typeof metadataChange?.agentId === "string" ? { agentId: metadataChange.agentId } : undefined,
      undefined,
      modelInvalidation ?? "preserve",
      {
        commandsChanged,
        // Fulfillment observations change speed hints, not session descriptor facts.
        refreshSessionFacts: metadataChange?.authChanged !== false,
      },
    );
  }
}
