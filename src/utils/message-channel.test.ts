import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
	createChannelTestPluginBase,
	createTestRegistry,
} from "../test-utils/channel-plugins.js";
import {
	isMarkdownCapableMessageChannel,
	resolveGatewayMessageChannel,
} from "./message-channel.js";

const emptyRegistry = createTestRegistry([]);
const demoAliasPlugin: ChannelPlugin = {
	...createChannelTestPluginBase({
		id: "demo-alias-channel",
		label: "Demo Alias Channel",
		docsPath: "/channels/demo-alias-channel",
	}),
	meta: {
		...createChannelTestPluginBase({
			id: "demo-alias-channel",
			label: "Demo Alias Channel",
			docsPath: "/channels/demo-alias-channel",
		}).meta,
		aliases: ["workspace-chat"],
	},
};

const demoMarkdownPlugin: ChannelPlugin = {
	...createChannelTestPluginBase({
		id: "demo-markdown-channel",
		label: "Demo Markdown Channel",
		docsPath: "/channels/demo-markdown-channel",
		markdownCapable: true,
	}),
};

describe("message-channel", () => {
	beforeEach(() => {
		setActivePluginRegistry(emptyRegistry);
	});

	afterEach(() => {
		setActivePluginRegistry(emptyRegistry);
	});

	it("normalizes gateway message channels and rejects unknown values", () => {
		expect(resolveGatewayMessageChannel("discord")).toBe("discord");
		expect(resolveGatewayMessageChannel(" imsg ")).toBe("imessage");
		expect(resolveGatewayMessageChannel("web")).toBeUndefined();
		expect(resolveGatewayMessageChannel("nope")).toBeUndefined();
	});

	it("normalizes plugin aliases when registered", () => {
		setActivePluginRegistry(
			createTestRegistry([
				{
					pluginId: "demo-alias-channel",
					plugin: demoAliasPlugin,
					source: "test",
				},
			]),
		);
		expect(resolveGatewayMessageChannel("workspace-chat")).toBe(
			"demo-alias-channel",
		);
	});

	it("reads markdown capability from channel metadata", () => {
		expect(isMarkdownCapableMessageChannel("telegram")).toBe(true);
		expect(isMarkdownCapableMessageChannel("whatsapp")).toBe(false);
		setActivePluginRegistry(
			createTestRegistry([
				{
					pluginId: "demo-markdown-channel",
					plugin: demoMarkdownPlugin,
					source: "test",
				},
			]),
		);
		expect(isMarkdownCapableMessageChannel("demo-markdown-channel")).toBe(true);
	});
});
