import { describe, expect, it } from "vitest";
import { resolveDiscordRuntimeGroupPolicy } from "../../../plugin-sdk/discord-surface.js";
import { resolveIMessageRuntimeGroupPolicy } from "../../../plugin-sdk/imessage-policy.js";
import { resolveSlackRuntimeGroupPolicy } from "../../../plugin-sdk/slack-surface.js";
import { resolveTelegramRuntimeGroupPolicy } from "../../../plugin-sdk/telegram-runtime-surface.js";
import { whatsappAccessControlTesting } from "../../../plugin-sdk/whatsapp-surface.js";
import {
  evaluateZaloGroupAccess,
  resolveZaloRuntimeGroupPolicy,
} from "../../../plugin-sdk/zalo.js";
import { installChannelRuntimeGroupPolicyFallbackSuite } from "./suites.js";

describe("channel runtime group policy contract", () => {
  describe("slack", () => {
    installChannelRuntimeGroupPolicyFallbackSuite({
      resolve: resolveSlackRuntimeGroupPolicy,
      configuredLabel: "keeps open default when channels.slack is configured",
      defaultGroupPolicyUnderTest: "open",
      missingConfigLabel: "fails closed when channels.slack is missing and no defaults are set",
      missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
    });
  });

  describe("telegram", () => {
    installChannelRuntimeGroupPolicyFallbackSuite({
      resolve: resolveTelegramRuntimeGroupPolicy,
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
      resolve: resolveIMessageRuntimeGroupPolicy,
      configuredLabel: "keeps open fallback when channels.imessage is configured",
      defaultGroupPolicyUnderTest: "disabled",
      missingConfigLabel: "fails closed when channels.imessage is missing and no defaults are set",
      missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
    });
  });

  describe("discord", () => {
    installChannelRuntimeGroupPolicyFallbackSuite({
      resolve: resolveDiscordRuntimeGroupPolicy,
      configuredLabel: "keeps open default when channels.discord is configured",
      defaultGroupPolicyUnderTest: "open",
      missingConfigLabel: "fails closed when channels.discord is missing and no defaults are set",
      missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
    });

    it("respects explicit provider policy", () => {
      const resolved = resolveDiscordRuntimeGroupPolicy({
        providerConfigPresent: false,
        groupPolicy: "disabled",
      });
      expect(resolved.groupPolicy).toBe("disabled");
      expect(resolved.providerMissingFallbackApplied).toBe(false);
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

    it("keeps provider-owned group access evaluation", () => {
      const decision = evaluateZaloGroupAccess({
        providerConfigPresent: true,
        configuredGroupPolicy: "allowlist",
        defaultGroupPolicy: "open",
        groupAllowFrom: ["zl:12345"],
        senderId: "12345",
      });
      expect(decision).toMatchObject({
        allowed: true,
        groupPolicy: "allowlist",
        reason: "allowed",
      });
    });
  });
});
