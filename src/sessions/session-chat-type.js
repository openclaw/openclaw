import { iterateBootstrapChannelPlugins } from "../channels/plugins/bootstrap-registry.js";
import { deriveSessionChatTypeFromKey, } from "./session-chat-type-shared.js";
export { deriveSessionChatTypeFromKey, } from "./session-chat-type-shared.js";
export function deriveSessionChatType(sessionKey) {
    const builtInType = deriveSessionChatTypeFromKey(sessionKey);
    if (builtInType !== "unknown") {
        return builtInType;
    }
    return deriveSessionChatTypeFromKey(sessionKey, Array.from(iterateBootstrapChannelPlugins())
        .map((plugin) => plugin.messaging?.deriveLegacySessionChatType)
        .filter((deriveLegacySessionChatType) => Boolean(deriveLegacySessionChatType)));
}
