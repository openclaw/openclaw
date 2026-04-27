export function formatChannelDefaultAccountPath(channelKey) {
    return `channels.${channelKey}.defaultAccount`;
}
export function formatChannelAccountsDefaultPath(channelKey) {
    return `channels.${channelKey}.accounts.default`;
}
export function formatSetExplicitDefaultInstruction(channelKey) {
    return `Set ${formatChannelDefaultAccountPath(channelKey)} or add ${formatChannelAccountsDefaultPath(channelKey)}`;
}
export function formatSetExplicitDefaultToConfiguredInstruction(params) {
    return `Set ${formatChannelDefaultAccountPath(params.channelKey)} to one of these accounts, or add ${formatChannelAccountsDefaultPath(params.channelKey)}`;
}
