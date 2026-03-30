import type { ZodType } from "zod";

export function safeParseWithSchema<T>(
	schema: ZodType<T>,
	value: unknown,
): T | null {
	const parsed = schema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

export function safeParseJsonWithSchema<T>(
	schema: ZodType<T>,
	raw: string,
): T | null {
	try {
		return safeParseWithSchema(schema, JSON.parse(raw));
	} catch {
		return null;
	}
}
