export type SystemdUnavailableKind = "missing_systemctl" | "user_bus_unavailable" | "generic_unavailable";
export declare function isSystemctlMissingDetail(detail?: string): boolean;
export declare function isSystemdUserBusUnavailableDetail(detail?: string): boolean;
export declare function classifySystemdUnavailableDetail(detail?: string): SystemdUnavailableKind | null;
