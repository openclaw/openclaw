import { z } from "zod";
import { DmPolicySchema } from "../../config/zod-schema.core.js";
export const AllowFromEntrySchema = z.union([z.string(), z.number()]);
export const AllowFromListSchema = z.array(AllowFromEntrySchema).optional();
export function buildNestedDmConfigSchema(extraShape) {
    const baseShape = {
        enabled: z.boolean().optional(),
        policy: DmPolicySchema.optional(),
        allowFrom: AllowFromListSchema,
    };
    return z.object(extraShape ? { ...baseShape, ...extraShape } : baseShape).optional();
}
export function buildCatchallMultiAccountChannelSchema(accountSchema) {
    return accountSchema.extend({
        accounts: z.object({}).catchall(accountSchema).optional(),
        defaultAccount: z.string().optional(),
    });
}
function cloneRuntimeIssue(issue) {
    const record = issue && typeof issue === "object" ? issue : {};
    const path = Array.isArray(record.path)
        ? record.path.filter((segment) => {
            const kind = typeof segment;
            return kind === "string" || kind === "number";
        })
        : undefined;
    return {
        ...record,
        ...(path ? { path } : {}),
    };
}
function safeParseRuntimeSchema(schema, value) {
    const result = schema.safeParse(value);
    if (result.success) {
        return {
            success: true,
            data: result.data,
        };
    }
    return {
        success: false,
        issues: result.error.issues.map((issue) => cloneRuntimeIssue(issue)),
    };
}
export function buildChannelConfigSchema(schema, options) {
    const schemaWithJson = schema;
    if (typeof schemaWithJson.toJSONSchema === "function") {
        return {
            schema: schemaWithJson.toJSONSchema({
                target: "draft-07",
                unrepresentable: "any",
            }),
            ...(options?.uiHints ? { uiHints: options.uiHints } : {}),
            runtime: {
                safeParse: (value) => safeParseRuntimeSchema(schema, value),
            },
        };
    }
    // Compatibility fallback for plugins built against Zod v3 schemas,
    // where `.toJSONSchema()` is unavailable.
    return {
        schema: {
            type: "object",
            additionalProperties: true,
        },
        ...(options?.uiHints ? { uiHints: options.uiHints } : {}),
        runtime: {
            safeParse: (value) => safeParseRuntimeSchema(schema, value),
        },
    };
}
export function emptyChannelConfigSchema() {
    return {
        schema: {
            type: "object",
            additionalProperties: false,
            properties: {},
        },
        runtime: {
            safeParse(value) {
                if (value === undefined) {
                    return { success: true, data: undefined };
                }
                if (!value || typeof value !== "object" || Array.isArray(value)) {
                    return {
                        success: false,
                        issues: [{ path: [], message: "expected config object" }],
                    };
                }
                if (Object.keys(value).length > 0) {
                    return {
                        success: false,
                        issues: [{ path: [], message: "config must be empty" }],
                    };
                }
                return { success: true, data: value };
            },
        },
    };
}
