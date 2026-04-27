import { jsonResult } from "./common.js";
import type { GatewayCallOptions } from "./gateway.js";
export declare const BLOCKED_INVOKE_COMMANDS: Set<string>;
export declare const NODE_READ_ACTION_COMMANDS: {
    readonly camera_list: "camera.list";
    readonly notifications_list: "notifications.list";
    readonly device_status: "device.status";
    readonly device_info: "device.info";
    readonly device_permissions: "device.permissions";
    readonly device_health: "device.health";
};
export type NodeCommandAction = keyof typeof NODE_READ_ACTION_COMMANDS | "notifications_action" | "location_get" | "invoke";
export declare function executeNodeCommandAction(params: {
    action: NodeCommandAction;
    input: Record<string, unknown>;
    gatewayOpts: GatewayCallOptions;
    allowMediaInvokeCommands?: boolean;
    mediaInvokeActions: Record<string, string>;
}): Promise<ReturnType<typeof jsonResult> | {
    content: Array<{
        type: "text";
        text: string;
    }>;
    details: Record<string, unknown>;
}>;
export declare function invokeNodeCommandPayload(params: {
    gatewayOpts: GatewayCallOptions;
    node: string;
    command: string;
    commandParams?: Record<string, unknown>;
}): Promise<unknown>;
