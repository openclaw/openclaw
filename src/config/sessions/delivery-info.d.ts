export { parseSessionThreadInfo } from "./thread-info.js";
export declare function extractDeliveryInfo(sessionKey: string | undefined): {
    deliveryContext: {
        channel?: string;
        to?: string;
        accountId?: string;
        threadId?: string;
    } | undefined;
    threadId: string | undefined;
};
