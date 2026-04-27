import type { ConfigUiHints } from "./schema.hints.js";
type ConfigSchema = Record<string, unknown>;
export type BaseConfigSchemaResponse = {
    schema: ConfigSchema;
    uiHints: ConfigUiHints;
    version: string;
    generatedAt: string;
};
export declare function computeBaseConfigSchemaResponse(params?: {
    generatedAt?: string;
}): BaseConfigSchemaResponse;
export {};
