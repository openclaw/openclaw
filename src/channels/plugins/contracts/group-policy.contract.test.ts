import { describe, expect, it } from "vitest";
import { discordMonitorTesting } from "../../../../extensions/discord/runtime-api.js";
import { imessageMonitorTesting } from "../../../../extensions/imessage/runtime-api.js";
import { slackMonitorTesting } from "../../../../extensions/slack/runtime-api.js";
import { resolveTelegramRuntimeGroupPolicy } from "../../../../extensions/telegram/runtime-api.js";
import { whatsappAccessControlTesting } from "../../../../extensions/whatsapp/api.js";
import {
  evaluateZaloGroupAccess,
  resolveZaloRuntimeGroupPolicy,
} from "../../../../extensions/zalo/api.js";
import { installChannelRuntimeGroupPolicyFallbackSuite } from "./suites.js";

describe("channel runtime group policy contract", () => {
  describe("slack", () => {
    installChannelRuntimeGroupPolicyFallbackSuite({
      resolve: slackMonitorTesting.resolveSlackRuntimeGroupPolicy,
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
      resolve: imessageMonitorTesting.resolveIMessageRuntimeGroupPolicy,
      configuredLabel: "keeps open fallback when channels.imessage is configured",
      defaultGroupPolicyUnderTest: "disabled",
      missingConfigLabel: "fails closed when channels.imessage is missing and no defaults are set",
      missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
    });
  });

  describe("discord", () => {
    installChannelRuntimeGroupPolicyFallbackSuite({
      resolve: discordMonitorTesting.resolveDiscordRuntimeGroupPolicy,
      configuredLabel: "keeps open default when channels.discord is configured",
      defaultGroupPolicyUnderTest: "open",
      missingConfigLabel: "fails closed when channels.discord is missing and no defaults are set",
      missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
    });

    it("respects explicit provider policy", () => {
      const resolved = discordMonitorTesting.resolveDiscordRuntimeGroupPolicy({
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
