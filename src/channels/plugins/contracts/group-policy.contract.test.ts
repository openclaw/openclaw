import { describe, expect, it } from "vitest";
import { whatsappAccessControlTesting } from "../../../../extensions/whatsapp/api.js";
import {
  evaluateZaloGroupAccess,
  resolveZaloRuntimeGroupPolicy,
} from "../../../../extensions/zalo/api.js";
import { resolveOpenProviderRuntimeGroupPolicy } from "../../../config/runtime-group-policy.js";

type RuntimeGroupPolicyResolver = (
  params: Parameters<typeof resolveOpenProviderRuntimeGroupPolicy>[0],
) => ReturnType<typeof resolveOpenProviderRuntimeGroupPolicy>;

function installChannelRuntimeGroupPolicyFallbackSuite(params: {
  configuredLabel: string;
  defaultGroupPolicyUnderTest: "allowlist" | "disabled" | "open";
  missingConfigLabel: string;
  missingDefaultLabel: string;
  resolve: RuntimeGroupPolicyResolver;
}) {
  it(params.missingConfigLabel, () => {
    const resolved = params.resolve({
      providerConfigPresent: false,
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(true);
  });

  it(params.configuredLabel, () => {
    const resolved = params.resolve({
      providerConfigPresent: true,
    });
    expect(resolved.groupPolicy).toBe("open");
    expect(resolved.providerMissingFallbackApplied).toBe(false);
  });

  it(params.missingDefaultLabel, () => {
    const resolved = params.resolve({
      providerConfigPresent: false,
      defaultGroupPolicy: params.defaultGroupPolicyUnderTest,
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(true);
  });
}

describe("channel runtime group policy contract", () => {
  type ResolvedGroupPolicy = ReturnType<typeof resolveOpenProviderRuntimeGroupPolicy>;

  function expectResolvedGroupPolicyCase(
    resolved: Pick<ResolvedGroupPolicy, "groupPolicy" | "providerMissingFallbackApplied">,
    expected: Pick<ResolvedGroupPolicy, "groupPolicy" | "providerMissingFallbackApplied">,
  ) {
    expect(resolved.groupPolicy).toBe(expected.groupPolicy);
    expect(resolved.providerMissingFallbackApplied).toBe(expected.providerMissingFallbackApplied);
  }

  function expectAllowedZaloGroupAccess(params: Parameters<typeof evaluateZaloGroupAccess>[0]) {
    expect(evaluateZaloGroupAccess(params)).toMatchObject({
      allowed: true,
      groupPolicy: "allowlist",
      reason: "allowed",
    });
  }

  function expectResolvedDiscordGroupPolicyCase(params: {
    providerConfigPresent: Parameters<
      typeof resolveOpenProviderRuntimeGroupPolicy
    >[0]["providerConfigPresent"];
    groupPolicy: Parameters<typeof resolveOpenProviderRuntimeGroupPolicy>[0]["groupPolicy"];
    expected: Pick<ResolvedGroupPolicy, "groupPolicy" | "providerMissingFallbackApplied">;
  }) {
    expectResolvedGroupPolicyCase(resolveOpenProviderRuntimeGroupPolicy(params), params.expected);
  }

  function expectAllowedZaloGroupAccessCase(
    params: Omit<Parameters<typeof evaluateZaloGroupAccess>[0], "groupAllowFrom"> & {
      groupAllowFrom: readonly string[];
    },
  ) {
    expectAllowedZaloGroupAccess({
      ...params,
      groupAllowFrom: [...params.groupAllowFrom],
    });
  }

  describe("slack", () => {
    installChannelRuntimeGroupPolicyFallbackSuite({
      resolve: resolveOpenProviderRuntimeGroupPolicy,
      configuredLabel: "keeps open default when channels.slack is configured",
      defaultGroupPolicyUnderTest: "open",
      missingConfigLabel: "fails closed when channels.slack is missing and no defaults are set",
      missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
    });
  });

  describe("telegram", () => {
    installChannelRuntimeGroupPolicyFallbackSuite({
      resolve: resolveOpenProviderRuntimeGroupPolicy,
      configuredLabel: "keeps open fallback when channels.telegram is configured",
      defaultGroupPolicyUnderTest: "disabled",
      missingConfigLabel: "fails closed when channels.telegram is missing and no defaults are set",
      missingDefaultLabel: "ignores explicit defaults when provider config is missing",
    });
  });

  describe("whatsapp", () => {
    installChannelRuntimeGroupPolicyFallbackSuite({
      resolve: whatsappAccessControlTesting.resolveWhatsAppRuntimeGroupPolicy,
      configuredLabel: "keeps open fallback when channels.whatsapp is configured",
      defaultGroupPolicyUnderTest: "disabled",
      missingConfigLabel: "fails closed when channels.whatsapp is missing and no defaults are set",
      missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
    });
  });

  describe("imessage", () => {
    installChannelRuntimeGroupPolicyFallbackSuite({
      resolve: resolveOpenProviderRuntimeGroupPolicy,
      configuredLabel: "keeps open fallback when channels.imessage is configured",
      defaultGroupPolicyUnderTest: "disabled",
      missingConfigLabel: "fails closed when channels.imessage is missing and no defaults are set",
      missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
    });
  });

  describe("discord", () => {
    installChannelRuntimeGroupPolicyFallbackSuite({
      resolve: resolveOpenProviderRuntimeGroupPolicy,
      configuredLabel: "keeps open default when channels.discord is configured",
      defaultGroupPolicyUnderTest: "open",
      missingConfigLabel: "fails closed when channels.discord is missing and no defaults are set",
      missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
    });

    it.each([
      {
        providerConfigPresent: false,
        groupPolicy: "disabled",
        expected: {
          groupPolicy: "disabled",
          providerMissingFallbackApplied: false,
        },
      },
    ] as const)("respects explicit provider policy %#", (testCase) => {
      expectResolvedDiscordGroupPolicyCase(testCase);
    });
  });

  describe("zalo", () => {
    installChannelRuntimeGroupPolicyFallbackSuite({
      resolve: resolveZaloRuntimeGroupPolicy,
      configuredLabel: "keeps open fallback when channels.zalo is configured",
      defaultGroupPolicyUnderTest: "open",
      missingConfigLabel: "fails closed when channels.zalo is missing and no defaults are set",
      missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
    });

    it.each([
      {
        providerConfigPresent: true,
        configuredGroupPolicy: "allowlist",
        defaultGroupPolicy: "open",
        groupAllowFrom: ["zl:12345"],
        senderId: "12345",
      },
    ] as const)("keeps provider-owned group access evaluation %#", (testCase) => {
      expectAllowedZaloGroupAccessCase(testCase);
    });
  });
});
