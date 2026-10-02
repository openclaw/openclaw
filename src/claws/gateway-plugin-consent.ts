import { stableStringify } from "@openclaw/normalization-core";
import type {
  ClawPluginAcknowledgement,
  ClawPluginReview,
} from "../../packages/gateway-protocol/src/schema/claws.js";
import type { ClawPluginInstallConsent } from "./packages.js";

export class ClawGatewayConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClawGatewayConsentError";
  }
}

/** Bind the browser's reviewed plugin facts to the immutable Add/Update plan. */
export function bindClawPluginInstallConsent(
  reviews: readonly ClawPluginReview[],
  acknowledgements: readonly ClawPluginAcknowledgement[] | undefined,
  assertCurrent: () => void,
): ClawPluginInstallConsent | undefined {
  const required = reviews.filter((review) => review.ownerAction === "install");
  const received = acknowledgements ?? [];
  if (required.length !== received.length) {
    throw new ClawGatewayConsentError("Review and acknowledge each plugin installation again.");
  }
  const byActionId = new Map<string, ClawPluginAcknowledgement>();
  for (const acknowledgement of received) {
    if (byActionId.has(acknowledgement.actionId)) {
      throw new ClawGatewayConsentError("Duplicate plugin capability acknowledgement.");
    }
    byActionId.set(acknowledgement.actionId, acknowledgement);
  }
  const byPluginId = new Map<string, ClawPluginReview>();
  for (const review of required) {
    const acknowledgement = byActionId.get(review.actionId);
    if (
      !acknowledgement ||
      acknowledgement.pluginId !== review.pluginId ||
      acknowledgement.reviewToken !== review.reviewToken ||
      stableStringify(acknowledgement.capabilityGrants) !==
        stableStringify(review.capabilityGrants) ||
      stableStringify(acknowledgement.capabilityGrantsByPluginId) !==
        stableStringify(review.capabilityGrantsByPluginId) ||
      Boolean(acknowledgement.acknowledgeRiskWarning) !== Boolean(review.riskWarning) ||
      byPluginId.has(review.pluginId)
    ) {
      throw new ClawGatewayConsentError("Plugin capabilities changed; review the Claw again.");
    }
    byPluginId.set(review.pluginId, review);
  }
  if (required.length === 0) {
    return undefined;
  }
  return {
    confirmInstall: async (pluginId, warning) => {
      assertCurrent();
      const planned = byPluginId.get(pluginId);
      if (!planned || warning !== planned.riskWarning) {
        throw new ClawGatewayConsentError("Plugin trust state changed; review the Claw again.");
      }
      return true;
    },
    onCapabilityConsent: async (runtimeReview) => {
      assertCurrent();
      const planned = byPluginId.get(runtimeReview.pluginId);
      if (
        !planned ||
        runtimeReview.reviewToken !== planned.reviewToken ||
        stableStringify(runtimeReview.grants) !== stableStringify(planned.capabilityGrants)
      ) {
        throw new ClawGatewayConsentError("Plugin capabilities changed; review the Claw again.");
      }
      return { reviewToken: runtimeReview.reviewToken };
    },
  };
}
