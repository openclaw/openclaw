declare function sleepSync(ms: number): void;
/**
 * Find PIDs of gateway processes listening on the given port using synchronous lsof.
 * Returns only PIDs that belong to openclaw gateway processes (not the current process).
 */
export declare function findGatewayPidsOnPortSync(port: number, spawnTimeoutMs?: number): number[];
/**
 * Inspect the gateway port and kill any stale gateway processes holding it.
 * Blocks until the port is confirmed free (or the poll budget expires) so
 * the supervisor (systemd / launchctl) does not race a zombie process for
 * the port and enter an EADDRINUSE restart loop.
 *
 * Called before service restart commands to prevent port conflicts.
 */
export declare function cleanStaleGatewayProcessesSync(portOverride?: number): number[];
export declare const __testing: {
    setSleepSyncOverride(fn: ((ms: number) => void) | null): void;
    setDateNowOverride(fn: (() => number) | null): void;
    setParentPidOverride(fn: (() => number) | null): void;
    /** Invoke sleepSync directly (bypasses the override) for unit-testing the real Atomics path. */
    callSleepSyncRaw: typeof sleepSync;
};
export {};
