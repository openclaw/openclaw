import { z } from "zod";

import { danger } from "./globals.js";
import { defaultRuntime, type RuntimeEnv } from "./runtime.js";

export type AuthMode =
	| { accountSid: string; authToken: string }
	| { accountSid: string; apiKey: string; apiSecret: string };

export type EnvConfig = {
	accountSid: string;
	whatsappFrom: string;
	whatsappSenderSid?: string;
	auth: AuthMode;
};

const EnvSchema = z
	.object({
		TWILIO_ACCOUNT_SID: z.string().min(1, "TWILIO_ACCOUNT_SID required"),
		TWILIO_WHATSAPP_FROM: z.string().min(1, "TWILIO_WHATSAPP_FROM required"),
		TWILIO_SENDER_SID: z.string().optional(),
		TWILIO_AUTH_TOKEN: z.string().optional(),
		TWILIO_API_KEY: z.string().optional(),
		TWILIO_API_SECRET: z.string().optional(),
	})
	.superRefine((val, ctx) => {
		if (val.TWILIO_API_KEY && !val.TWILIO_API_SECRET) {
			ctx.addIssue({
				code: "custom",
				message: "TWILIO_API_SECRET required when TWILIO_API_KEY is set",
			});
		}
		if (val.TWILIO_API_SECRET && !val.TWILIO_API_KEY) {
			ctx.addIssue({
				code: "custom",
				message: "TWILIO_API_KEY required when TWILIO_API_SECRET is set",
			});
		}
		if (
			!val.TWILIO_AUTH_TOKEN &&
			!(val.TWILIO_API_KEY && val.TWILIO_API_SECRET)
		) {
			ctx.addIssue({
				code: "custom",
				message:
					"Provide TWILIO_AUTH_TOKEN or both TWILIO_API_KEY and TWILIO_API_SECRET",
			});
		}
	});

export function readEnv(runtime: RuntimeEnv = defaultRuntime): EnvConfig {
	// Load and validate Twilio auth + sender configuration from env.
	const parsed = EnvSchema.safeParse(process.env);
	if (!parsed.success) {
		runtime.error("Invalid environment configuration:");
		parsed.error.issues.forEach((iss) => {
			runtime.error(`- ${iss.message}`);
		});
		runtime.exit(1);
	}

	const {
		TWILIO_ACCOUNT_SID: accountSid,
		TWILIO_WHATSAPP_FROM: whatsappFrom,
		TWILIO_SENDER_SID: whatsappSenderSid,
		TWILIO_AUTH_TOKEN: authToken,
		TWILIO_API_KEY: apiKey,
		TWILIO_API_SECRET: apiSecret,
	} = parsed.data;

	let auth: AuthMode;
	if (apiKey && apiSecret) {
		auth = { accountSid, apiKey, apiSecret };
	} else if (authToken) {
		auth = { accountSid, authToken };
	} else {
		runtime.error("Missing Twilio auth configuration");
		runtime.exit(1);
		throw new Error("unreachable");
	}

	return {
		accountSid,
		whatsappFrom,
		whatsappSenderSid,
		auth,
	};
}

export function ensureTwilioEnv(runtime: RuntimeEnv = defaultRuntime) {
	// Guardrails: fail fast when Twilio env vars are missing or incomplete.
	const required = ["TWILIO_ACCOUNT_SID", "TWILIO_WHATSAPP_FROM"];
	const missing = required.filter((k) => !process.env[k]);
	const hasToken = Boolean(process.env.TWILIO_AUTH_TOKEN);
	const hasKey = Boolean(
		process.env.TWILIO_API_KEY && process.env.TWILIO_API_SECRET,
	);
	if (missing.length > 0 || (!hasToken && !hasKey)) {
		runtime.error(
			danger(
				`Missing Twilio env: ${missing.join(", ") || "auth token or api key/secret"}. Set them in .env before using provider=twilio.`,
			),
		);
		runtime.exit(1);
	}
}
