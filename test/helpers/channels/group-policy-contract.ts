import { expect, it } from "vitest";
import { installChannelRuntimeGroupPolicyFallbackSuite } from "../../../src/channels/plugins/contracts/suites.js";
import { resolveOpenProviderRuntimeGroupPolicy } from "../../../src/config/runtime-group-policy.js";
import { whatsappAccessControlTesting } from "../../../src/plugin-sdk/whatsapp-surface.js";
import {
	evaluateZaloGroupAccess,
	resolveZaloRuntimeGroupPolicy,
} from "../../../src/plugin-sdk/zalo-setup.js";

export function installSlackGroupPolicyContractSuite() {
	installChannelRuntimeGroupPolicyFallbackSuite({
		resolve: resolveOpenProviderRuntimeGroupPolicy,
		configuredLabel: "keeps open default when channels.slack is configured",
		defaultGroupPolicyUnderTest: "open",
		missingConfigLabel:
			"fails closed when channels.slack is missing and no defaults are set",
		missingDefaultLabel:
			"ignores explicit global defaults when provider config is missing",
	});
}

export function installTelegramGroupPolicyContractSuite() {
	installChannelRuntimeGroupPolicyFallbackSuite({
		resolve: resolveOpenProviderRuntimeGroupPolicy,
		configuredLabel: "keeps open fallback when channels.telegram is configured",
		defaultGroupPolicyUnderTest: "disabled",
		missingConfigLabel:
			"fails closed when channels.telegram is missing and no defaults are set",
		missingDefaultLabel:
			"ignores explicit defaults when provider config is missing",
	});
}

export function installWhatsAppGroupPolicyContractSuite() {
	installChannelRuntimeGroupPolicyFallbackSuite({
		resolve: whatsappAccessControlTesting.resolveWhatsAppRuntimeGroupPolicy,
		configuredLabel: "keeps open fallback when channels.whatsapp is configured",
		defaultGroupPolicyUnderTest: "disabled",
		missingConfigLabel:
			"fails closed when channels.whatsapp is missing and no defaults are set",
		missingDefaultLabel:
			"ignores explicit global defaults when provider config is missing",
	});
}

export function installIMessageGroupPolicyContractSuite() {
	installChannelRuntimeGroupPolicyFallbackSuite({
		resolve: resolveOpenProviderRuntimeGroupPolicy,
		configuredLabel: "keeps open fallback when channels.imessage is configured",
		defaultGroupPolicyUnderTest: "disabled",
		missingConfigLabel:
			"fails closed when channels.imessage is missing and no defaults are set",
		missingDefaultLabel:
			"ignores explicit global defaults when provider config is missing",
	});
}

export function installDiscordGroupPolicyContractSuite() {
	installChannelRuntimeGroupPolicyFallbackSuite({
		resolve: resolveOpenProviderRuntimeGroupPolicy,
		configuredLabel: "keeps open default when channels.discord is configured",
		defaultGroupPolicyUnderTest: "open",
		missingConfigLabel:
			"fails closed when channels.discord is missing and no defaults are set",
		missingDefaultLabel:
			"ignores explicit global defaults when provider config is missing",
	});

	it("respects explicit provider policy", () => {
		const resolved = resolveOpenProviderRuntimeGroupPolicy({
			providerConfigPresent: false,
			groupPolicy: "disabled",
		});
		expect(resolved.groupPolicy).toBe("disabled");
		expect(resolved.providerMissingFallbackApplied).toBe(false);
	});
}

export function installZaloGroupPolicyContractSuite() {
	installChannelRuntimeGroupPolicyFallbackSuite({
		resolve: resolveZaloRuntimeGroupPolicy,
		configuredLabel: "keeps open fallback when channels.zalo is configured",
		defaultGroupPolicyUnderTest: "open",
		missingConfigLabel:
			"fails closed when channels.zalo is missing and no defaults are set",
		missingDefaultLabel:
			"ignores explicit global defaults when provider config is missing",
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
}
