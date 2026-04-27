import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type SecretRef } from "../config/types.secrets.js";
type SecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];
export declare function resolveSecretInputString(params: {
    config: OpenClawConfig;
    value: unknown;
    env: NodeJS.ProcessEnv;
    defaults?: SecretDefaults;
    normalize?: (value: unknown) => string | undefined;
    onResolveRefError?: (error: unknown, ref: SecretRef) => never;
}): Promise<string | undefined>;
export {};
