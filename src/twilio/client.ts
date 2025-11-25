import Twilio from "twilio";
import type { EnvConfig } from "../env.js";

export function createClient(env: EnvConfig) {
	// Twilio client using either auth token or API key/secret.
	if ("authToken" in env.auth) {
		return Twilio(env.accountSid, env.auth.authToken, {
			accountSid: env.accountSid,
		});
	}
	return Twilio(env.auth.apiKey, env.auth.apiSecret, {
		accountSid: env.accountSid,
	});
}
