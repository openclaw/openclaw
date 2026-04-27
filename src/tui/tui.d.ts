import { type OpenClawConfig } from "../config/config.js";
import type { TuiBackend } from "./tui-backend.js";
import type { SessionScope, TuiOptions, TuiResult } from "./tui-types.js";
export { resolveFinalAssistantText } from "./tui-formatters.js";
export type { TuiOptions } from "./tui-types.js";
export { createEditorSubmitHandler, createSubmitBurstCoalescer, shouldEnableWindowsGitBashPasteFallback, } from "./tui-submit.js";
type RunTuiOptions = TuiOptions & {
    backend?: TuiBackend;
    config?: OpenClawConfig;
    title?: string;
};
/** Resolve the absolute path to the `codex` CLI binary, or `null` if not installed. */
export declare function resolveCodexCliBin(): string | null;
export declare function resolveLocalAuthCliInvocation(params?: {
    execPath?: string;
    wrapperPath?: string;
    runNodePath?: string;
    hasDistEntry?: boolean;
    hasRunNodeScript?: boolean;
}): {
    command: string;
    args: string[];
};
export declare function resolveLocalAuthSpawnOptions(params: {
    command: string;
    platform?: NodeJS.Platform;
}): {
    shell?: true;
};
export declare function resolveLocalAuthSpawnCwd(params: {
    args: string[];
    defaultCwd?: string;
}): string;
export declare function resolveTuiSessionKey(params: {
    raw?: string;
    sessionScope: SessionScope;
    currentAgentId: string;
    sessionMainKey: string;
}): string;
export declare function resolveInitialTuiAgentId(params: {
    cfg: OpenClawConfig;
    fallbackAgentId: string;
    initialSessionInput?: string;
    cwd?: string;
}): string;
export declare function resolveGatewayDisconnectState(reason?: string): {
    connectionStatus: string;
    activityStatus: string;
    pairingHint?: string;
};
export declare function createBackspaceDeduper(params?: {
    dedupeWindowMs?: number;
    now?: () => number;
}): (data: string) => string;
export declare function isIgnorableTuiStopError(error: unknown): boolean;
export declare function stopTuiSafely(stop: () => void): void;
type DrainableTui = {
    stop: () => void;
    terminal?: {
        drainInput?: (maxMs?: number, idleMs?: number) => Promise<void>;
    };
};
export declare function drainAndStopTuiSafely(tui: DrainableTui): Promise<void>;
type CtrlCAction = "clear" | "warn" | "exit";
export declare function resolveCtrlCAction(params: {
    hasInput: boolean;
    now: number;
    lastCtrlCAt: number;
    exitWindowMs?: number;
}): {
    action: CtrlCAction;
    nextLastCtrlCAt: number;
};
export declare function runTui(opts: RunTuiOptions): Promise<TuiResult>;
