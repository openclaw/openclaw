type JsonSchemaObject = {
    type?: string | string[];
    properties?: Record<string, JsonSchemaObject>;
    additionalProperties?: JsonSchemaObject | boolean;
    items?: JsonSchemaObject | JsonSchemaObject[];
    anyOf?: JsonSchemaObject[];
    allOf?: JsonSchemaObject[];
    oneOf?: JsonSchemaObject[];
};
export declare function cloneSchema<T>(value: T): T;
export declare function asSchemaObject(value: unknown): object | null;
export declare function schemaHasChildren(schema: JsonSchemaObject): boolean;
export declare function findWildcardHintMatch<T>(params: {
    uiHints: Record<string, T>;
    path: string;
    splitPath: (path: string) => string[];
}): {
    path: string;
    hint: T;
} | null;
export {};
