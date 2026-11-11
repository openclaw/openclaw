import { expect, it, vi } from "vitest";
import type {
  TemplatePluginAcknowledgement,
  TemplatePluginReview,
} from "../../packages/gateway-protocol/src/schema/templates.js";
import { bindTemplatePluginInstallConsent as bindConsent } from "./gateway-plugin-consent.js";
import { emptyPluginCapabilityEvidence } from "./packages.test-support.js";

const grants = {
  hooks: {
    allowPromptInjection: { effective: false },
    allowConversationAccess: { effective: false },
  },
};
const review: TemplatePluginReview = {
  actionId: "plugin:@example/sample-runner",
  pluginId: "sample-runner",
  ref: "@example/sample-runner",
  version: "1.0.0",
  ownerAction: "install",
  integrity: `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`,
  declaredCapabilities: { ...emptyPluginCapabilityEvidence.declared, tools: ["sample-runner.run"] },
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
const acknowledgement: TemplatePluginAcknowledgement = {
  ...review,
  acknowledgeRiskWarning: true,
};

const changedCapabilities = "Plugin capabilities changed; review the Template again.";
const changedTrust = "Plugin trust state changed; review the Template again.";
const runtimeReview = (
  capabilityGrants: TemplatePluginAcknowledgement["capabilityGrants"] = grants,
) =>
  ({
    pluginId: review.pluginId,
    reviewToken: review.reviewToken,
    grants: capabilityGrants,
  }) as Parameters<NonNullable<ReturnType<typeof bindConsent>>["onCapabilityConsent"]>[0];
const bind = (assertCurrent: () => void = vi.fn()) =>
  bindConsent([review], [acknowledgement], assertCurrent);

const confirm = (
  consent: ReturnType<typeof bindConsent>,
  warning: string | undefined,
  pluginId = review.pluginId,
) => consent?.confirmInstall?.(pluginId, warning);
const receipt = { reviewToken: review.reviewToken };

it.each([true, false])("approves only the clean reviewed receipt (direct: %s)", async (direct) => {
  const assertCurrent = vi.fn();
  const consent = bindConsent(
    [{ ...review, riskWarning: undefined }],
    direct ? undefined : [{ ...acknowledgement, acknowledgeRiskWarning: undefined }],
    assertCurrent,
    { allowCleanDirectInstall: direct },
  );
  expect(await confirm(consent, undefined)).toBe(true);
  expect(await consent?.onCapabilityConsent(runtimeReview())).toEqual(receipt);
  expect(assertCurrent).toHaveBeenCalledTimes(2);
  await expect(confirm(consent, review.riskWarning)).rejects.toThrow(changedTrust);
});

it("requires the complete exact install review, while reuse needs no acknowledgement", () => {
  const assertCurrent = vi.fn();
  expect(() =>
    bindConsent([review], undefined, assertCurrent, { allowCleanDirectInstall: true }),
  ).toThrow("needs approval before this Template can be installed");
  expect(() => bindConsent([review], undefined, assertCurrent)).toThrow(
    "Review and acknowledge each plugin installation again.",
  );
  expect(
    bindConsent([{ ...review, ownerAction: "reuse" }], undefined, assertCurrent),
  ).toBeUndefined();
  expect(() => bindConsent([], [acknowledgement], assertCurrent)).toThrow();
  expect(() => bindConsent([review], [acknowledgement, acknowledgement], assertCurrent)).toThrow();
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
    expect(() => bindConsent([review], [changed], assertCurrent)).toThrow(changedCapabilities);
  }
});

it("grants installer consent only for the exact live reviewed surface", async () => {
  const assertCurrent = vi.fn();
  const consent = bind(assertCurrent);
  expect(await confirm(consent, review.riskWarning)).toBe(true);
  expect(await consent?.onCapabilityConsent(runtimeReview())).toEqual(receipt);
  expect(assertCurrent).toHaveBeenCalledTimes(2);
  await expect(
    consent?.onCapabilityConsent(runtimeReview({ ...grants, llm: { allowModelOverride: true } })),
  ).rejects.toThrow(changedCapabilities);
  await expect(confirm(consent, "New trust warning.")).rejects.toThrow(changedTrust);
  await expect(confirm(consent, review.riskWarning, "different")).rejects.toThrow(changedTrust);
});

it("rejects a stale request at the installer callback", async () => {
  const consent = bind(() => {
    throw new Error("Labs disabled");
  });
  await expect(confirm(consent, review.riskWarning)).rejects.toThrow("Labs disabled");
});
