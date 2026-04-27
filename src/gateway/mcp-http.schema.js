import { logWarn } from "../logger.js";
function flattenUnionSchema(raw) {
    const variants = (raw.anyOf ?? raw.oneOf);
    if (!Array.isArray(variants) || variants.length === 0) {
        return raw;
    }
    const mergedProps = {};
    const requiredSets = [];
    for (const variant of variants) {
        const props = variant.properties;
        if (props) {
            for (const [key, schema] of Object.entries(props)) {
                if (!(key in mergedProps)) {
                    mergedProps[key] = schema;
                    continue;
                }
                const existing = mergedProps[key];
                const incoming = schema;
                if (Array.isArray(existing.enum) && Array.isArray(incoming.enum)) {
                    mergedProps[key] = {
                        ...existing,
                        enum: [...new Set([...existing.enum, ...incoming.enum])],
                    };
                    continue;
                }
                if ("const" in existing && "const" in incoming && existing.const !== incoming.const) {
                    const merged = {
                        ...existing,
                        enum: [existing.const, incoming.const],
                    };
                    delete merged.const;
                    mergedProps[key] = merged;
                    continue;
                }
                logWarn(`mcp loopback: conflicting schema definitions for "${key}", keeping the first variant`);
            }
        }
        requiredSets.push(new Set(Array.isArray(variant.required) ? variant.required : []));
    }
    const required = requiredSets.length > 0
        ? [...(requiredSets[0] ?? [])].filter((key) => requiredSets.every((set) => set.has(key)))
        : [];
    const { anyOf: _anyOf, oneOf: _oneOf, ...rest } = raw;
    return { ...rest, type: "object", properties: mergedProps, required };
}
export function buildMcpToolSchema(tools) {
    return tools.map((tool) => {
        let raw = tool.parameters && typeof tool.parameters === "object"
            ? { ...tool.parameters }
            : {};
        if (raw.anyOf || raw.oneOf) {
            raw = flattenUnionSchema(raw);
        }
        if (raw.type !== "object") {
            raw.type = "object";
        }
        if (!raw.properties) {
            raw.properties = {};
        }
        return {
            name: tool.name,
            description: tool.description,
            inputSchema: raw,
        };
    });
}
