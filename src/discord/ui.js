import { Container } from "@buape/carbon";
import { resolveDiscordAccount } from "./accounts.js";
const DEFAULT_DISCORD_ACCENT_COLOR = "#5865F2";
export function normalizeDiscordAccentColor(raw) {
    const trimmed = (raw ?? "").trim();
    if (!trimmed) {
        return null;
    }
    const normalized = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
    if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) {
        return null;
    }
    return normalized.toUpperCase();
}
export function resolveDiscordAccentColor(params) {
    const account = resolveDiscordAccount({ cfg: params.cfg, accountId: params.accountId });
    const configured = normalizeDiscordAccentColor(account.config.ui?.components?.accentColor);
    return configured ?? DEFAULT_DISCORD_ACCENT_COLOR;
}
export class DiscordUiContainer extends Container {
    constructor(params) {
        const accentOverride = normalizeDiscordAccentColor(params.accentColor);
        const accentColor = accentOverride ?? resolveDiscordAccentColor({ cfg: params.cfg, accountId: params.accountId });
        super(params.components, { accentColor, spoiler: params.spoiler });
    }
}
