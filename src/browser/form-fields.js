export const DEFAULT_FILL_FIELD_TYPE = "text";
export function normalizeBrowserFormFieldRef(value) {
    return typeof value === "string" ? value.trim() : "";
}
export function normalizeBrowserFormFieldType(value) {
    const type = typeof value === "string" ? value.trim() : "";
    return type || DEFAULT_FILL_FIELD_TYPE;
}
export function normalizeBrowserFormFieldValue(value) {
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? value
        : undefined;
}
export function normalizeBrowserFormField(record) {
    const ref = normalizeBrowserFormFieldRef(record.ref);
    if (!ref) {
        return null;
    }
    const type = normalizeBrowserFormFieldType(record.type);
    const value = normalizeBrowserFormFieldValue(record.value);
    return value === undefined ? { ref, type } : { ref, type, value };
}
