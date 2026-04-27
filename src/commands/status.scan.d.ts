import type { RuntimeEnv } from "../runtime.js";
import type { StatusScanResult } from "./status.scan-result.ts";
export declare function scanStatus(opts: {
    json?: boolean;
    timeoutMs?: number;
    all?: boolean;
}, _runtime: RuntimeEnv): Promise<StatusScanResult>;
