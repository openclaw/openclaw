import { describe, expect, it, vi } from "vitest";
import type {
  ClawPluginAcknowledgement,
  ClawPluginReview,
} from "../../packages/gateway-protocol/src/schema/claws.js";
import { bindClawPluginInstallConsent } from "./gateway-plugin-consent.js";

const grants = {
  hooks: {
    allowPromptInjection: { effective: false },
    allowConversationAccess: { effective: false },
  },
};
const declared = {
  channels: [],
  providers: [],
  tools: ["sample-runner.run"],
  contracts: [],
  hooks: [],
  mcpServers: [],
  cliCommands: [],
  cliBackends: [],
  skills: [],
  dangerousConfigFlags: [],
};
const review: ClawPluginReview = {
  actionId: "plugin:@example/sample-runner",
  pluginId: "sample-runner",
  ref: "@example/sample-runner",
  version: "1.0.0",
  ownerAction: "install",
  integrity: `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`,
  declaredCapabilities: declared,
  capabilityGrants: grants,
  capabilityGrantsByPluginId: {
    "sample-runner/index": grants,
    "sample-runner/child": {
      ...grants,
      hooks: { ...grants.hooks, allowConversationAccess: { effective: true } },
    },
  },
  reviewToken: "reviewed-surface",
  riskWarning: "This plugin can run workflows.",
};
const acknowledgement: ClawPluginAcknowledgement = {
  actionId: review.actionId,
  pluginId: review.pluginId,
  reviewToken: review.reviewToken,
  capabilityGrants: grants,
  capabilityGrantsByPluginId: review.capabilityGrantsByPluginId,
  acknowledgeRiskWarning: true,
};

describe("Gateway Claw plugin consent", () => {
  it("allows a direct Claw install to approve a clean plugin from the current sealed plan", async () => {
    const cleanReview = { ...review, riskWarning: undefined };
    const assertCurrent = vi.fn();
    const consent = bindClawPluginInstallConsent([cleanReview], undefined, assertCurrent, {
      allowCleanDirectInstall: true,
    });
    expect(await consent?.confirmInstall?.(review.pluginId, undefined)).toBe(true);
    expect(
      await consent?.onCapabilityConsent({
        pluginId: review.pluginId,
        reviewToken: review.reviewToken,
        grants,
      } as Parameters<NonNullable<typeof consent>["onCapabilityConsent"]>[0]),
    ).toEqual({ reviewToken: review.reviewToken });
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    expect(() =>
      bindClawPluginInstallConsent([review], undefined, assertCurrent, {
        allowCleanDirectInstall: true,
      }),
    ).toThrow("needs approval before this Claw can be installed");
  });

  it("requires the complete exact install review, while reuse needs no acknowledgement", () => {
    const assertCurrent = vi.fn();
    expect(() => bindClawPluginInstallConsent([review], undefined, assertCurrent)).toThrow(
      "Review and acknowledge each plugin installation again.",
    );
    expect(
      bindClawPluginInstallConsent([{ ...review, ownerAction: "reuse" }], undefined, assertCurrent),
    ).toBeUndefined();
    expect(() => bindClawPluginInstallConsent([], [acknowledgement], assertCurrent)).toThrow();
    expect(() =>
      bindClawPluginInstallConsent([review], [acknowledgement, acknowledgement], assertCurrent),
    ).toThrow();
  });

  it("rejects changed grants, tokens, identity, and unacknowledged risk", () => {
    const assertCurrent = vi.fn();
    for (const changed of [
      { ...acknowledgement, pluginId: "different" },
      { ...acknowledgement, reviewToken: "changed" },
      { ...acknowledgement, capabilityGrants: { ...grants, llm: { allowModelOverride: true } } },
      {
        ...acknowledgement,
        capabilityGrantsByPluginId: {
          ...review.capabilityGrantsByPluginId,
          "sample-runner/child": grants,
        },
      },
      { ...acknowledgement, acknowledgeRiskWarning: undefined },
    ]) {
      expect(() => bindClawPluginInstallConsent([review], [changed], assertCurrent)).toThrow(
        "Plugin capabilities changed; review the Claw again.",
      );
    }
  });

  it("grants installer consent only for the exact live reviewed surface", async () => {
    const assertCurrent = vi.fn();
    const consent = bindClawPluginInstallConsent([review], [acknowledgement], assertCurrent);
    expect(consent).toBeDefined();
    expect(await consent?.confirmInstall?.(review.pluginId, review.riskWarning)).toBe(true);
    expect(
      await consent?.onCapabilityConsent({
        pluginId: review.pluginId,
        reviewToken: review.reviewToken,
        grants,
      } as Parameters<NonNullable<typeof consent>["onCapabilityConsent"]>[0]),
    ).toEqual({ reviewToken: review.reviewToken });
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    await expect(
      consent?.onCapabilityConsent({
        pluginId: review.pluginId,
        reviewToken: review.reviewToken,
        grants: { ...grants, llm: { allowModelOverride: true } },
      } as Parameters<NonNullable<typeof consent>["onCapabilityConsent"]>[0]),
    ).rejects.toThrow("Plugin capabilities changed; review the Claw again.");
    await expect(consent?.confirmInstall?.(review.pluginId, "New trust warning.")).rejects.toThrow(
      "Plugin trust state changed; review the Claw again.",
    );
    await expect(consent?.confirmInstall?.("different", review.riskWarning)).rejects.toThrow(
      "Plugin trust state changed; review the Claw again.",
    );
  });

  it("accepts a clean final trust check only for the clean reviewed receipt", async () => {
    const cleanReview = { ...review, riskWarning: undefined };
    const cleanAcknowledgement: ClawPluginAcknowledgement = {
      actionId: review.actionId,
      pluginId: review.pluginId,
      reviewToken: review.reviewToken,
      capabilityGrants: grants,
      capabilityGrantsByPluginId: review.capabilityGrantsByPluginId,
    };
    const consent = bindClawPluginInstallConsent([cleanReview], [cleanAcknowledgement], () => {});
    expect(await consent?.confirmInstall?.(review.pluginId, undefined)).toBe(true);
    await expect(consent?.confirmInstall?.(review.pluginId, review.riskWarning)).rejects.toThrow(
      "Plugin trust state changed; review the Claw again.",
    );
  });

  it("rejects a stale request at the installer callback", async () => {
    const consent = bindClawPluginInstallConsent([review], [acknowledgement], () => {
      throw new Error("Labs disabled");
    });
    await expect(consent?.confirmInstall?.(review.pluginId, review.riskWarning)).rejects.toThrow(
      "Labs disabled",
    );
  });
});
