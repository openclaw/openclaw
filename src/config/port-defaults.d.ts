export type PortRange = {
    start: number;
    end: number;
};
export declare const DEFAULT_BRIDGE_PORT = 18790;
export declare const DEFAULT_BROWSER_CONTROL_PORT = 18791;
export declare const DEFAULT_CANVAS_HOST_PORT = 18793;
export declare const DEFAULT_BROWSER_CDP_PORT_RANGE_START = 18800;
export declare const DEFAULT_BROWSER_CDP_PORT_RANGE_END = 18899;
export declare function deriveDefaultBridgePort(gatewayPort: number): number;
export declare function deriveDefaultBrowserControlPort(gatewayPort: number): number;
export declare function deriveDefaultCanvasHostPort(gatewayPort: number): number;
export declare function deriveDefaultBrowserCdpPortRange(browserControlPort: number): PortRange;
