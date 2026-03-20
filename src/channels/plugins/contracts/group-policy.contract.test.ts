import { describe, expect, it } from "vitest";
import { __testing as discordTesting } from "../../../../extensions/discord/src/monitor/provider.js";
import { __testing as imessageTesting } from "../../../../extensions/imessage/src/monitor/monitor-provider.js";
import { __testing as slackTesting } from "../../../../extensions/slack/src/monitor/provider.js";
import { resolveTelegramRuntimeGroupPolicy } from "../../../../extensions/telegram/src/group-access.js";
import { __testing as whatsappTesting } from "../../../../extensions/whatsapp/src/inbound/access-control.js";
import { __testing as zaloTesting } from "../../../../extensions/zalo/src/monitor.js";
import { installChannelRuntimeGroupPolicyFallbackSuite } from "./suites.js";

describe("channel runtime group policy contract", () => {
  describe("slack", () => {
    installChannelRuntimeGroupPolicyFallbackSuite({
      resolve: slackTesting.resolveSlackRuntimeGroupPolicy,
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
      resolve: whatsappTesting.resolveWhatsAppRuntimeGroupPolicy,
      configuredLabel: "keeps open fallback when channels.whatsapp is configured",
      defaultGroupPolicyUnderTest: "disabled",
      missingConfigLabel: "fails closed when channels.whatsapp is missing and no defaults are set",
      missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
    });
  });

  describe("imessage", () => {
    installChannelRuntimeGroupPolicyFallbackSuite({
      resolve: imessageTesting.resolveIMessageRuntimeGroupPolicy,
      configuredLabel: "keeps open fallback when channels.imessage is configured",
      defaultGroupPolicyUnderTest: "disabled",
      missingConfigLabel: "fails closed when channels.imessage is missing and no defaults are set",
      missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
    });
  });

  describe("discord", () => {
    installChannelRuntimeGroupPolicyFallbackSuite({
      resolve: discordTesting.resolveDiscordRuntimeGroupPolicy,
      configuredLabel: "keeps open default when channels.discord is configured",
      defaultGroupPolicyUnderTest: "open",
      missingConfigLabel: "fails closed when channels.discord is missing and no defaults are set",
      missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
    });

    it("respects explicit provider policy", () => {
      const resolved = discordTesting.resolveDiscordRuntimeGroupPolicy({
        providerConfigPresent: false,
        groupPolicy: "disabled",
      });
      expect(resolved.groupPolicy).toBe("disabled");
      expect(resolved.providerMissingFallbackApplied).toBe(false);
    });
  });

  describe("zalo", () => {
    installChannelRuntimeGroupPolicyFallbackSuite({
      resolve: zaloTesting.resolveZaloRuntimeGroupPolicy,
      configuredLabel: "keeps open fallback when channels.zalo is configured",
      defaultGroupPolicyUnderTest: "open",
      missingConfigLabel: "fails closed when channels.zalo is missing and no defaults are set",
      missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
    });

    it("keeps provider-owned group access evaluation", () => {
      const decision = zaloTesting.evaluateZaloGroupAccess({
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
