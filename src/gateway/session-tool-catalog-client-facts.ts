import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../packages/gateway-protocol/src/client-info.js";
import { TOOL_CATALOG_CLIENT_CAPS } from "../agents/openclaw-tools.client-caps.js";
import type { SessionEntry, SessionToolCatalogClientFacts } from "../config/sessions/types.js";
import { isOperatorUiClient } from "../utils/message-channel.js";
import type { GatewayClient } from "./server-methods/client-types.js";
import { isSyntheticGatewayCaller } from "./server-methods/gateway-personal-caller.js";

/** Admin operator UI clients that declared the capability can receive task suggestions. */
export function supportsGatewayTaskSuggestions(client: GatewayClient | null | undefined): boolean {
  return (
    isOperatorUiClient(client?.connect?.client) &&
    client?.connect?.scopes?.includes("operator.admin") === true &&
    hasGatewayClientCap(client?.connect?.caps, GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS)
  );
}

/**
 * Catalog facts an interactive Gateway client records on its session. Synthetic
 * in-process callers have no client surface, so they record nothing.
 */
export function resolveInteractiveToolCatalogClientFacts(
  client: GatewayClient | null | undefined,
): SessionToolCatalogClientFacts | undefined {
  if (!client || isSyntheticGatewayCaller(client)) {
    return undefined;
  }
  return buildToolCatalogClientFacts(client.connect?.caps, supportsGatewayTaskSuggestions(client));
}

/**
 * Recorded catalog facts that a caller without a client surface declares, so its
 * thread-stable catalog matches the session's interactive turns. Interactive
 * callers declare their own tools. Only known catalog caps survive, so an older
 * or malformed record cannot widen the catalog.
 */
export function resolveDeclaredToolCatalogClientFacts(params: {
  client: GatewayClient | null;
  sessionEntry?: Pick<SessionEntry, "toolCatalogClientFacts">;
}): SessionToolCatalogClientFacts | undefined {
  const facts: unknown = params.sessionEntry?.toolCatalogClientFacts;
  return isSyntheticGatewayCaller(params.client) &&
    isRecord(facts) &&
    Array.isArray(facts.clientCaps)
    ? buildToolCatalogClientFacts(facts.clientCaps, facts.taskSuggestionDeliveryMode === "gateway")
    : undefined;
}

// Canonical order keeps equal facts byte-identical in entry_json and catalogs.
function buildToolCatalogClientFacts(
  declaredCaps: readonly unknown[] | undefined,
  supportsTaskSuggestions: boolean,
): SessionToolCatalogClientFacts {
  return {
    clientCaps: TOOL_CATALOG_CLIENT_CAPS.filter((cap) => declaredCaps?.includes(cap)),
    ...(supportsTaskSuggestions ? { taskSuggestionDeliveryMode: "gateway" as const } : {}),
  };
}
