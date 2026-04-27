export type DeviceBootstrapProfile = {
    roles: string[];
    scopes: string[];
};
export type DeviceBootstrapProfileInput = {
    roles?: readonly string[];
    scopes?: readonly string[];
};
export declare const BOOTSTRAP_HANDOFF_OPERATOR_SCOPES: readonly ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"];
export declare const PAIRING_SETUP_BOOTSTRAP_PROFILE: DeviceBootstrapProfile;
export declare function resolveBootstrapProfileScopesForRole(role: string, scopes: readonly string[]): string[];
export declare function normalizeDeviceBootstrapProfile(input: DeviceBootstrapProfileInput | undefined): DeviceBootstrapProfile;
