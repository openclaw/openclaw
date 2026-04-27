export declare function readGatewayProcessArgsSync(pid: number): string[] | null;
export declare function signalVerifiedGatewayPidSync(pid: number, signal: "SIGTERM" | "SIGUSR1"): void;
export declare function findVerifiedGatewayListenerPidsOnPortSync(port: number): number[];
export declare function formatGatewayPidList(pids: number[]): string;
