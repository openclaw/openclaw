export type GatewaySelfPresence = {
    host?: string;
    ip?: string;
    version?: string;
    platform?: string;
};
export declare function pickGatewaySelfPresence(presence: unknown): GatewaySelfPresence | null;
