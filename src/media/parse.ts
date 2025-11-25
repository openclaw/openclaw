// Shared helpers for parsing MEDIA tokens from command/stdout text.

export const MEDIA_LINE_RE = /\bMEDIA:/i;
// Allow optional wrapping backticks and punctuation after the token; capture the core token.
export const MEDIA_TOKEN_RE = /\bMEDIA:\s*`?([^\s`]+)`?/i;

export function normalizeMediaSource(src: string) {
	if (src.startsWith("file://")) return src.replace("file://", "");
	return src;
}

export function splitMediaFromOutput(raw: string): {
	text: string;
	mediaUrl?: string;
} {
	const trimmedRaw = raw.trim();
	let text = trimmedRaw;
	let mediaUrl: string | undefined;

	const globalMatch = trimmedRaw.match(MEDIA_TOKEN_RE);
	let mediaLine = trimmedRaw.split("\n").find((line) => MEDIA_LINE_RE.test(line));
	let mediaMatch = mediaLine?.match(MEDIA_TOKEN_RE) ?? globalMatch;
	if (!mediaMatch) {
		return { text: trimmedRaw };
	}
	if (!mediaLine && mediaMatch) {
		mediaLine = mediaMatch[0];
	}

	let isValidMedia = false;
	if (mediaMatch?.[1]) {
		const cleaned = mediaMatch[1]
			.replace(/^[`"'[{(]+/, "")
			.replace(/[`"'\\})\],]+$/, "");
		const candidate = normalizeMediaSource(cleaned);
		const looksLikeUrl = /^https?:\/\//i.test(candidate);
		const looksLikePath = candidate.startsWith("/") || candidate.startsWith("./");
		const hasWhitespace = /\s/.test(candidate);
		isValidMedia =
			!hasWhitespace && candidate.length <= 1024 && (looksLikeUrl || looksLikePath);
		if (isValidMedia) {
			mediaUrl = candidate;
		}
	}

	if (isValidMedia && mediaMatch?.[0]) {
		text = trimmedRaw
			.replace(mediaMatch[0], "")
			.replace(/[ \t]{2,}/g, " ")
			.replace(/[ \t]+\n/g, "\n")
			.replace(/\n{2,}/g, "\n")
			.trim();
	} else {
		text = trimmedRaw
			.split("\n")
			.filter((line) => line !== mediaLine)
			.join("\n")
			.replace(/[ \t]{2,}/g, " ")
			.replace(/[ \t]+\n/g, "\n")
			.replace(/\n{2,}/g, "\n")
			.trim();
	}

	return { text, mediaUrl };
}
