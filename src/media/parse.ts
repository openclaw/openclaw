// Shared helpers for parsing MEDIA tokens from command/stdout text.

// Allow optional wrapping backticks and punctuation after the token; capture the core token.
export const MEDIA_TOKEN_RE = /\bMEDIA:\s*`?([^\s`]+)`?/i;

export function normalizeMediaSource(src: string) {
	return src.startsWith("file://") ? src.replace("file://", "") : src;
}

function cleanCandidate(raw: string) {
	return raw.replace(/^[`"'[{(]+/, "").replace(/[`"'\\})\],]+$/, "");
}

function isValidMedia(candidate: string) {
	if (!candidate) return false;
	if (candidate.length > 1024) return false;
	if (/\s/.test(candidate)) return false;
	return /^https?:\/\//i.test(candidate) || candidate.startsWith("/") || candidate.startsWith("./");
}

export function splitMediaFromOutput(raw: string): {
	text: string;
	mediaUrl?: string;
} {
	const trimmedRaw = raw.trim();
	const match = MEDIA_TOKEN_RE.exec(trimmedRaw);
	if (!match?.[1]) return { text: trimmedRaw };

	const candidate = normalizeMediaSource(cleanCandidate(match[1]));
	const mediaUrl = isValidMedia(candidate) ? candidate : undefined;

	const cleanedText =
		mediaUrl
			? trimmedRaw
					.replace(match[0], "")
					.replace(/[ \t]+\n/g, "\n")
					.replace(/[ \t]{2,}/g, " ")
					.replace(/\n{2,}/g, "\n")
					.trim()
			: trimmedRaw
					.split("\n")
					.filter((line) => !MEDIA_TOKEN_RE.test(line))
					.join("\n")
					.replace(/[ \t]+\n/g, "\n")
					.replace(/[ \t]{2,}/g, " ")
					.replace(/\n{2,}/g, "\n")
					.trim();

	return mediaUrl ? { text: cleanedText, mediaUrl } : { text: cleanedText };
}
