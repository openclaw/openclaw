/**
 * Tracks the success/failure status of outbound message delivery.
 * Addresses #53961.
 */
export interface DeliveryStatus {
    requested: boolean;
    attempted: boolean;
    succeeded: boolean;
    reason?: string;
}

export class DeliveryTracker {
    static logFailure(sessionKey: string, reason: string) {
        console.warn(`[delivery] [${sessionKey}] Delivery requested but not completed: ${reason}`);
    }

    static getStatus(requested: boolean, succeeded: boolean, reason?: string): DeliveryStatus {
        return { requested, attempted: requested, succeeded, reason };
    }
}
