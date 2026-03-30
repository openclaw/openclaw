import { BUNDLED_PROVIDER_AUTH_ENV_VAR_CANDIDATES } from "../plugins/bundled-provider-auth-env-vars.js";

const CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES = {
	chutes: ["CHUTES_OAUTH_TOKEN", "CHUTES_API_KEY"],
	voyage: ["VOYAGE_API_KEY"],
	groq: ["GROQ_API_KEY"],
	deepgram: ["DEEPGRAM_API_KEY"],
	cerebras: ["CEREBRAS_API_KEY"],
	litellm: ["LITELLM_API_KEY"],
} as const;

const CORE_PROVIDER_SETUP_ENV_VAR_OVERRIDES = {
	anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
	chutes: ["CHUTES_API_KEY", "CHUTES_OAUTH_TOKEN"],
	"minimax-cn": ["MINIMAX_API_KEY"],
} as const;

/**
 * Provider auth env candidates used by generic auth resolution.
 *
 * Order matters: the first non-empty value wins for helpers such as
 * `resolveEnvApiKey()`. Bundled providers source this from plugin manifest
 * metadata so auth probes do not need to load plugin runtime.
 */
export const PROVIDER_AUTH_ENV_VAR_CANDIDATES: Record<
	string,
	readonly string[]
> = {
	...BUNDLED_PROVIDER_AUTH_ENV_VAR_CANDIDATES,
	...CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES,
};

/**
 * Provider env vars used for setup/default secret refs and broad secret
 * scrubbing. This can include non-model providers and may intentionally choose
 * a different preferred first env var than auth resolution.
 *
 * Bundled provider auth envs come from plugin manifests. The override map here
 * is only for true core/non-plugin providers and a few setup-specific ordering
 * overrides where generic onboarding wants a different preferred env var.
 */
export const PROVIDER_ENV_VARS: Record<string, readonly string[]> = {
	...PROVIDER_AUTH_ENV_VAR_CANDIDATES,
	...CORE_PROVIDER_SETUP_ENV_VAR_OVERRIDES,
};

export function getProviderEnvVars(providerId: string): string[] {
	const envVars = Object.hasOwn(PROVIDER_ENV_VARS, providerId)
		? PROVIDER_ENV_VARS[providerId]
		: undefined;
	return Array.isArray(envVars) ? [...envVars] : [];
}

const EXTRA_PROVIDER_AUTH_ENV_VARS = ["MINIMAX_CODE_PLAN_KEY"] as const;

const KNOWN_SECRET_ENV_VARS = [
	...new Set(Object.values(PROVIDER_ENV_VARS).flat()),
];

// OPENCLAW_API_KEY authenticates the local OpenClaw bridge itself and must
// remain available to child bridge/runtime processes.
const KNOWN_PROVIDER_AUTH_ENV_VARS = [
	...new Set([
		...Object.values(PROVIDER_AUTH_ENV_VAR_CANDIDATES).flat(),
		...KNOWN_SECRET_ENV_VARS,
		...EXTRA_PROVIDER_AUTH_ENV_VARS,
	]),
];

export function listKnownProviderAuthEnvVarNames(): string[] {
	return [...KNOWN_PROVIDER_AUTH_ENV_VARS];
}

export function listKnownSecretEnvVarNames(): string[] {
	return [...KNOWN_SECRET_ENV_VARS];
}

export function omitEnvKeysCaseInsensitive(
	baseEnv: NodeJS.ProcessEnv,
	keys: Iterable<string>,
): NodeJS.ProcessEnv {
	const env = { ...baseEnv };
	const denied = new Set<string>();
	for (const key of keys) {
		const normalizedKey = key.trim();
		if (normalizedKey) {
			denied.add(normalizedKey.toUpperCase());
		}
	}
	if (denied.size === 0) {
		return env;
	}
	for (const actualKey of Object.keys(env)) {
		if (denied.has(actualKey.toUpperCase())) {
			delete env[actualKey];
		}
	}
	return env;
}
