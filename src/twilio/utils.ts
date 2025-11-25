import { danger, info } from "../globals.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

type TwilioApiError = {
	code?: number | string;
	status?: number | string;
	message?: string;
	moreInfo?: string;
	response?: { body?: unknown };
};

export function formatTwilioError(err: unknown): string {
	// Normalize Twilio error objects into a single readable string.
	const e = err as TwilioApiError;
	const pieces = [];
	if (e.code != null) pieces.push(`code ${e.code}`);
	if (e.status != null) pieces.push(`status ${e.status}`);
	if (e.message) pieces.push(e.message);
	if (e.moreInfo) pieces.push(`more: ${e.moreInfo}`);
	return pieces.length ? pieces.join(" | ") : String(err);
}

export function logTwilioSendError(
	err: unknown,
	destination?: string,
	runtime: RuntimeEnv = defaultRuntime,
) {
	// Friendly error logger for send failures, including response body when present.
	const prefix = destination ? `to ${destination}: ` : "";
	runtime.error(
		danger(`❌ Twilio send failed ${prefix}${formatTwilioError(err)}`),
	);
	const body = (err as TwilioApiError)?.response?.body;
	if (body) {
		runtime.error(info("Response body:"), JSON.stringify(body, null, 2));
	}
}
