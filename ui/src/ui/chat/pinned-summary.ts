import { extractTextCached } from "./message-extract.ts";

export function getPinnedMessageSummary(message: unknown): string {
	return extractTextCached(message) ?? "";
}
