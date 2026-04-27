import { logVerbose } from "../../globals.js";
import { buildStatusText } from "../../status/status-text.js";
export { buildStatusText } from "../../status/status-text.js";
export async function buildStatusReply(params) {
    const { command } = params;
    if (!command.isAuthorizedSender) {
        logVerbose(`Ignoring /status from unauthorized sender: ${command.senderId || "<unknown>"}`);
        return undefined;
    }
    return {
        text: await buildStatusText({
            ...params,
            statusChannel: command.channel,
        }),
    };
}
