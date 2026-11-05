import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../packages/gateway-protocol/src/client-info.js";
import type {
  SessionGitHubPublicationPublished,
  SessionGitHubPublicationResult,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

type Client = GatewayRequestHandlerOptions["client"];

/** Older clients validate closed receipt shapes. Internal tools use the current protocol. */
export function presentGitHubPublicationReceipt(
  client: Client,
  receipt: SessionGitHubPublicationPublished,
): SessionGitHubPublicationPublished;
export function presentGitHubPublicationReceipt(
  client: Client,
  receipt: SessionGitHubPublicationResult,
): SessionGitHubPublicationResult;
export function presentGitHubPublicationReceipt(
  client: Client,
  receipt: SessionGitHubPublicationResult,
) {
  if (
    receipt.status !== "published" ||
    !receipt.unchanged ||
    !client ||
    getGatewayToolCallerIdentity() ||
    hasGatewayClientCap(client.connect?.caps, GATEWAY_CLIENT_CAPS.GITHUB_PUBLICATION_UNCHANGED)
  ) {
    return receipt;
  }
  const presented = { ...receipt };
  delete presented.unchanged;
  return presented;
}
