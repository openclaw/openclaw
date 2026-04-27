import { Writable } from "node:stream";
import type { GatewayService } from "../../daemon/service.js";
export type DaemonAction = "install" | "uninstall" | "start" | "stop" | "restart";
export type DaemonHintKind = "install" | "container-restart" | "container-foreground" | "systemd-unavailable" | "systemd-headless" | "wsl-systemd" | "generic";
export type DaemonHintItem = {
    kind: DaemonHintKind;
    text: string;
};
export type DaemonActionResponse = {
    ok: boolean;
    action: DaemonAction;
    result?: string;
    message?: string;
    error?: string;
    hints?: string[];
    hintItems?: DaemonHintItem[];
    warnings?: string[];
    service?: {
        label: string;
        loaded: boolean;
        loadedText: string;
        notLoadedText: string;
    };
};
export declare function emitDaemonActionJson(payload: DaemonActionResponse): void;
export declare function buildDaemonHintItems(hints: string[] | undefined): DaemonHintItem[] | undefined;
export declare function buildDaemonServiceSnapshot(service: GatewayService, loaded: boolean): {
    label: string;
    loaded: boolean;
    loadedText: string;
    notLoadedText: string;
};
export declare function createNullWriter(): Writable;
export declare function createDaemonActionContext(params: {
    action: DaemonAction;
    json: boolean;
}): {
    stdout: Writable;
    warnings: string[];
    emit: (payload: Omit<DaemonActionResponse, "action">) => void;
    fail: (message: string, hints?: string[]) => void;
};
export declare function installDaemonServiceAndEmit(params: {
    serviceNoun: string;
    service: GatewayService;
    warnings: string[];
    emit: (payload: Omit<DaemonActionResponse, "action">) => void;
    fail: (message: string, hints?: string[]) => void;
    install: () => Promise<void>;
}): Promise<void>;
