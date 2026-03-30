import { extractTextCached } from "./message-extract.ts";

export function messageMatchesSearchQuery(
	message: unknown,
	query: string,
): boolean {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) {
		return true;
	}
	const text = (extractTextCached(message) ?? "").toLowerCase();
	return text.includes(normalizedQuery);
}
