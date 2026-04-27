// Keep this local so browser bundles do not pull in src/utils.ts and its Node-only side effects.
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function asRecord(value) {
    return typeof value === "object" && value !== null ? value : {};
}
export function readStringField(record, key) {
    const value = record?.[key];
    return typeof value === "string" ? value : undefined;
}
export function asOptionalRecord(value) {
    return isRecord(value) ? value : undefined;
}
export function asNullableRecord(value) {
    return isRecord(value) ? value : null;
}
export function asOptionalObjectRecord(value) {
    return value && typeof value === "object" ? value : undefined;
}
export function asNullableObjectRecord(value) {
    return value && typeof value === "object" ? value : null;
}
