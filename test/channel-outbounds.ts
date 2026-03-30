import type { ChannelOutboundAdapter } from "../src/channels/plugins/types.js";
import {
	loadBundledPluginPublicSurfaceSync,
	loadBundledPluginTestApiSync,
} from "../src/test-utils/bundled-plugin-public-surface.js";

export const { discordOutbound } = loadBundledPluginTestApiSync<{
	discordOutbound: ChannelOutboundAdapter;
}>("discord");
export const { imessageOutbound } = loadBundledPluginPublicSurfaceSync<{
	imessageOutbound: ChannelOutboundAdapter;
}>({
	pluginId: "imessage",
	artifactBasename: "src/outbound-adapter.js",
});
export const { signalOutbound } = loadBundledPluginTestApiSync<{
	signalOutbound: ChannelOutboundAdapter;
}>("signal");
export const { slackOutbound } = loadBundledPluginTestApiSync<{
	slackOutbound: ChannelOutboundAdapter;
}>("slack");
export const { telegramOutbound } = loadBundledPluginPublicSurfaceSync<{
	telegramOutbound: ChannelOutboundAdapter;
}>({
	pluginId: "telegram",
	artifactBasename: "src/outbound-adapter.js",
});
export const { whatsappOutbound } = loadBundledPluginTestApiSync<{
	whatsappOutbound: ChannelOutboundAdapter;
}>("whatsapp");
