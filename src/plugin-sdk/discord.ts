// plugin-sdk/discord — public re-export surface for Discord component helpers.
//
// Plugins that depend on `openclaw/plugin-sdk/discord` can import the Discord
// component-message utilities and account resolver from this subpath without
// needing to reach into internal extension paths directly.
export type { DiscordComponentMessageSpec } from "../../extensions/discord/src/components.js";
export { buildDiscordComponentMessage } from "../../extensions/discord/src/components.js";
export { resolveDiscordAccount } from "../../extensions/discord/src/accounts.js";
export {
  editDiscordComponentMessage,
  registerBuiltDiscordComponentMessage,
} from "../../extensions/discord/src/send.components.js";
