import { createRequire } from "node:module";
import { appendAllowedValuesHint, summarizeAllowedValues } from "../config/allowed-values.js";
import { sanitizeTerminalText } from "../terminal/safe-text.js";
const require = createRequire(import.meta.url);
const ajvSingletons = new Map();
function getAjv(mode) {
    const cached = ajvSingletons.get(mode);
    if (cached) {
        return cached;
    }
    const ajvModule = require("ajv");
    const AjvCtor = typeof ajvModule.default === "function"
        ? ajvModule.default
        : ajvModule;
    const instance = new AjvCtor({
        allErrors: true,
        strict: false,
        removeAdditional: false,
        ...(mode === "defaults" ? { useDefaults: true } : {}),
    });
    instance.addFormat("uri", {
        type: "string",
        validate: (value) => {
            // Accept absolute URIs so generated config schemas can keep JSON Schema
            // `format: "uri"` without noisy AJV warnings during validation/build.
            return URL.canParse(value);
        },
    });
    ajvSingletons.set(mode, instance);
    return instance;
}
const schemaCache = new Map();
function cloneValidationValue(value) {
    if (value === undefined || value === null) {
        return value;
    }
    return structuredClone(value);
}
function normalizeAjvPath(instancePath) {
    const path = instancePath?.replace(/^\//, "").replace(/\//g, ".");
    return path && path.length > 0 ? path : "<root>";
}
function appendPathSegment(path, segment) {
    const trimmed = segment.trim();
    if (!trimmed) {
        return path;
    }
    if (path === "<root>") {
        return trimmed;
    }
    return `${path}.${trimmed}`;
}
function resolveMissingProperty(error) {
    if (error.keyword !== "required" &&
        error.keyword !== "dependentRequired" &&
        error.keyword !== "dependencies") {
        return null;
    }
    const missingProperty = error.params.missingProperty;
    return typeof missingProperty === "string" && missingProperty.trim() ? missingProperty : null;
}
function resolveAjvErrorPath(error) {
    const basePath = normalizeAjvPath(error.instancePath);
    const missingProperty = resolveMissingProperty(error);
    if (!missingProperty) {
        return basePath;
    }
    return appendPathSegment(basePath, missingProperty);
}
function extractAllowedValues(error) {
    if (error.keyword === "enum") {
        const allowedValues = error.params.allowedValues;
        return Array.isArray(allowedValues) ? allowedValues : null;
    }
    if (error.keyword === "const") {
        const params = error.params;
        if (!Object.prototype.hasOwnProperty.call(params, "allowedValue")) {
            return null;
        }
        return [params.allowedValue];
    }
    return null;
}
function getAjvAllowedValuesSummary(error) {
    const allowedValues = extractAllowedValues(error);
    if (!allowedValues) {
        return null;
    }
    return summarizeAllowedValues(allowedValues);
}
function formatAjvErrors(errors) {
    if (!errors || errors.length === 0) {
        return [{ path: "<root>", message: "invalid config", text: "<root>: invalid config" }];
    }
    return errors.map((error) => {
        const path = resolveAjvErrorPath(error);
        const baseMessage = error.message ?? "invalid";
        const allowedValuesSummary = getAjvAllowedValuesSummary(error);
        const message = allowedValuesSummary
            ? appendAllowedValuesHint(baseMessage, allowedValuesSummary)
            : baseMessage;
        const safePath = sanitizeTerminalText(path);
        const safeMessage = sanitizeTerminalText(message);
        return {
            path,
            message,
            text: `${safePath}: ${safeMessage}`,
            ...(allowedValuesSummary
                ? {
                    allowedValues: allowedValuesSummary.values,
                    allowedValuesHiddenCount: allowedValuesSummary.hiddenCount,
                }
                : {}),
        };
    });
}
export function validateJsonSchemaValue(params) {
    const cacheKey = params.applyDefaults ? `${params.cacheKey}::defaults` : params.cacheKey;
    let cached = schemaCache.get(cacheKey);
    if (!cached || cached.schema !== params.schema) {
        const validate = getAjv(params.applyDefaults ? "defaults" : "default").compile(params.schema);
        cached = { validate, schema: params.schema };
        schemaCache.set(cacheKey, cached);
    }
    const value = params.applyDefaults ? cloneValidationValue(params.value) : params.value;
    const ok = cached.validate(value);
    if (ok) {
        return { ok: true, value };
    }
    return { ok: false, errors: formatAjvErrors(cached.validate.errors) };
}
