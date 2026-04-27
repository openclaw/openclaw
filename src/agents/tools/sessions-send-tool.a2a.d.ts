import type { CallGatewayOptions } from "../../gateway/call.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
type GatewayCaller = <T = unknown>(opts: CallGatewayOptions) => Promise<T>;
export declare function runSessionsSendA2AFlow(params: {
    targetSessionKey: string;
    displayKey: string;
    message: string;
    announceTimeoutMs: number;
    maxPingPongTurns: number;
    requesterSessionKey?: string;
    requesterChannel?: GatewayMessageChannel;
    roundOneReply?: string;
    waitRunId?: string;
}): Promise<void>;
export declare const __testing: {
    setDepsForTest(overrides?: Partial<{
        callGateway: GatewayCaller;
    }>): void;
};
export {};
