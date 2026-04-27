export function safeParseWithSchema(schema, value) {
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}
export function safeParseJsonWithSchema(schema, raw) {
    try {
        return safeParseWithSchema(schema, JSON.parse(raw));
    }
    catch {
        return null;
    }
}
