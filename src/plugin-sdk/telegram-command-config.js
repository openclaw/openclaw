import { normalizeCommandDescription, normalizeSlashCommandName, resolveCustomCommands, } from "../shared/custom-command-config.js";
const TELEGRAM_COMMAND_NAME_PATTERN_VALUE = /^[a-z0-9_]{1,32}$/;
const TELEGRAM_CUSTOM_COMMAND_CONFIG = {
    label: "Telegram",
    pattern: TELEGRAM_COMMAND_NAME_PATTERN_VALUE,
    patternDescription: "use a-z, 0-9, underscore; max 32 chars",
};
function normalizeTelegramCommandNameImpl(value) {
    return normalizeSlashCommandName(value);
}
function normalizeTelegramCommandDescriptionImpl(value) {
    return normalizeCommandDescription(value);
}
function resolveTelegramCustomCommandsImpl(params) {
    return resolveCustomCommands({
        ...params,
        config: TELEGRAM_CUSTOM_COMMAND_CONFIG,
    });
}
export function getTelegramCommandNamePattern() {
    return TELEGRAM_COMMAND_NAME_PATTERN_VALUE;
}
export const TELEGRAM_COMMAND_NAME_PATTERN = TELEGRAM_COMMAND_NAME_PATTERN_VALUE;
export function normalizeTelegramCommandName(value) {
    return normalizeTelegramCommandNameImpl(value);
}
export function normalizeTelegramCommandDescription(value) {
    return normalizeTelegramCommandDescriptionImpl(value);
}
export function resolveTelegramCustomCommands(params) {
    return resolveTelegramCustomCommandsImpl(params);
}
