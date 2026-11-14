import { stableStringify } from "@openclaw/normalization-core";
import type {
  TemplatePluginAcknowledgement,
  TemplatePluginReview,
} from "../../packages/gateway-protocol/src/schema/templates.js";
import type { TemplatePluginInstallConsent } from "./packages.js";

export class TemplateGatewayConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateGatewayConsentError";
  }
}

/** Bind the browser's reviewed plugin facts to the immutable Add/Update plan. */
export function bindTemplatePluginInstallConsent(
  reviews: readonly TemplatePluginReview[],
  acknowledgements: readonly TemplatePluginAcknowledgement[] | undefined,
  assertCurrent: () => void,
  options: { allowCleanDirectInstall?: boolean } = {},
): TemplatePluginInstallConsent | undefined {
  const required = reviews.filter((review) => review.ownerAction === "install");
  const received =
    options.allowCleanDirectInstall && acknowledgements === undefined
      ? required.map((review) => {
          if (review.riskWarning) {
            throw new TemplateGatewayConsentError(
              `Plugin ${review.ref} needs approval before this Template can be installed.`,
            );
          }
          return {
            actionId: review.actionId,
            pluginId: review.pluginId,
            reviewToken: review.reviewToken,
            capabilityGrants: review.capabilityGrants,
            capabilityGrantsByPluginId: review.capabilityGrantsByPluginId,
          };
        })
      : (acknowledgements ?? []);
  if (required.length !== received.length) {
    throw new TemplateGatewayConsentError("Review and acknowledge each plugin installation again.");
  }
  const byActionId = new Map<string, TemplatePluginAcknowledgement>();
  for (const acknowledgement of received) {
    if (byActionId.has(acknowledgement.actionId)) {
      throw new TemplateGatewayConsentError("Duplicate plugin capability acknowledgement.");
    }
    byActionId.set(acknowledgement.actionId, acknowledgement);
  }
  const byPluginId = new Map<string, TemplatePluginReview>();
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
      throw new TemplateGatewayConsentError(
        "Plugin capabilities changed; review the Template again.",
      );
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
        throw new TemplateGatewayConsentError(
          "Plugin trust state changed; review the Template again.",
        );
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
        throw new TemplateGatewayConsentError(
          "Plugin capabilities changed; review the Template again.",
        );
      }
      return { reviewToken: runtimeReview.reviewToken };
    },
  };
}
