import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let ajvSingleton = null;
function getAjv() {
    if (ajvSingleton) {
        return ajvSingleton;
    }
    const ajvModule = require("ajv");
    const AjvCtor = typeof ajvModule.default === "function"
        ? ajvModule.default
        : ajvModule;
    ajvSingleton = new AjvCtor({
        allErrors: true,
        strict: false,
        removeAdditional: false,
    });
    return ajvSingleton;
}
const schemaCache = new Map();
function formatAjvErrors(errors) {
    if (!errors || errors.length === 0) {
        return ["invalid config"];
    }
    return errors.map((error) => {
        const path = error.instancePath?.replace(/^\//, "").replace(/\//g, ".") || "<root>";
        const message = error.message ?? "invalid";
        return `${path}: ${message}`;
    });
}
export function validateJsonSchemaValue(params) {
    let cached = schemaCache.get(params.cacheKey);
    if (!cached || cached.schema !== params.schema) {
        const validate = getAjv().compile(params.schema);
        cached = { validate, schema: params.schema };
        schemaCache.set(params.cacheKey, cached);
    }
    const ok = cached.validate(params.value);
    if (ok) {
        return { ok: true };
    }
    return { ok: false, errors: formatAjvErrors(cached.validate.errors) };
}
