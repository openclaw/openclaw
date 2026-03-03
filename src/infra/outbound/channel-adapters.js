import { Separator, TextDisplay } from "@buape/carbon";
import { DiscordUiContainer } from "../../discord/ui.js";
class CrossContextContainer extends DiscordUiContainer {
    constructor({ originLabel, message, cfg, accountId }) {
        const trimmed = message.trim();
        const components = [];
        if (trimmed) {
            components.push(new TextDisplay(message));
            components.push(new Separator({ divider: true, spacing: "small" }));
        }
        components.push(new TextDisplay(`*From ${originLabel}*`));
        super({ cfg, accountId, components });
    }
}
const DEFAULT_ADAPTER = {
    supportsComponentsV2: false,
};
const DISCORD_ADAPTER = {
    supportsComponentsV2: true,
    buildCrossContextComponents: ({ originLabel, message, cfg, accountId }) => [
        new CrossContextContainer({ originLabel, message, cfg, accountId }),
    ],
};
export function getChannelMessageAdapter(channel) {
    if (channel === "discord") {
        return DISCORD_ADAPTER;
    }
    return DEFAULT_ADAPTER;
}
