// Shared helpers for parsing MEDIA tokens from command/stdout text.

export const MEDIA_LINE_RE = /\bMEDIA:/i;
export const MEDIA_TOKEN_RE = /\bMEDIA:\s*([^\s]+)/i;

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

	const mediaLine = trimmedRaw.split("\n").find((line) => MEDIA_LINE_RE.test(line));
	if (!mediaLine) {
		return { text: trimmedRaw };
	}

	let isValidMedia = false;
	const mediaMatch = mediaLine.match(MEDIA_TOKEN_RE);
	if (mediaMatch?.[1]) {
		const candidate = normalizeMediaSource(mediaMatch[1]);
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
