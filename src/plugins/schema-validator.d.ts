import type { JsonSchemaObject } from "../shared/json-schema.types.js";
export type JsonSchemaValidationError = {
    path: string;
    message: string;
    text: string;
    allowedValues?: string[];
    allowedValuesHiddenCount?: number;
};
export declare function validateJsonSchemaValue(params: {
    schema: JsonSchemaObject;
    cacheKey: string;
    value: unknown;
    applyDefaults?: boolean;
}): {
    ok: true;
    value: unknown;
} | {
    ok: false;
    errors: JsonSchemaValidationError[];
};
