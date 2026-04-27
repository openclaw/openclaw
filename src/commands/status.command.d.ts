import { type ConnectPairingRequiredReason } from "../gateway/protocol/connect-error-details.js";
import { type RuntimeEnv } from "../runtime.js";
export declare function resolvePairingRecoveryContext(params: {
    error?: string | null;
    closeReason?: string | null;
    details?: unknown;
}): {
    requestId: string | null;
    reason: ConnectPairingRequiredReason | null;
    remediationHint: string | null;
} | null;
export declare function statusCommand(opts: {
    json?: boolean;
    deep?: boolean;
    usage?: boolean;
    timeoutMs?: number;
    verbose?: boolean;
    all?: boolean;
}, runtime: RuntimeEnv): Promise<void>;
