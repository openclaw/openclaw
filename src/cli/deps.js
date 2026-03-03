import { createOutboundSendDepsFromCliSource } from "./outbound-send-mapping.js";
export function createDefaultDeps() {
    return {
        sendMessageWhatsApp: async (...args) => {
            const { sendMessageWhatsApp } = await import("../channels/web/index.js");
            return await sendMessageWhatsApp(...args);
        },
        sendMessageTelegram: async (...args) => {
            const { sendMessageTelegram } = await import("../telegram/send.js");
            return await sendMessageTelegram(...args);
        },
        sendMessageDiscord: async (...args) => {
            const { sendMessageDiscord } = await import("../discord/send.js");
            return await sendMessageDiscord(...args);
        },
        sendMessageSlack: async (...args) => {
            const { sendMessageSlack } = await import("../slack/send.js");
            return await sendMessageSlack(...args);
        },
        sendMessageSignal: async (...args) => {
            const { sendMessageSignal } = await import("../signal/send.js");
            return await sendMessageSignal(...args);
        },
        sendMessageIMessage: async (...args) => {
            const { sendMessageIMessage } = await import("../imessage/send.js");
            return await sendMessageIMessage(...args);
        },
    };
}
export function createOutboundSendDeps(deps) {
    return createOutboundSendDepsFromCliSource(deps);
}
export { logWebSelfId } from "../web/auth-store.js";
