import crypto from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import {
  DEFAULT_SECRET_PROVIDER_ALIAS,
  type SecretInput,
  type SecretRef,
  hasConfiguredSecretInput,
  normalizeSecretInputString,
} from "../config/types.secrets.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { isRemoteEnvironment } from "./oauth-env.js";
import { openUrl } from "./onboard-helpers.js";
import type { SecretInputMode } from "./onboard-types.js";

export type SearchProvider = "brave" | "firecrawl" | "gemini" | "grok" | "kimi" | "perplexity";

type SearchProviderEntry = {
  value: SearchProvider;
  label: string;
  hint: string;
  envKeys: string[];
  placeholder: string;
  signupUrl: string;
  /** If true, provider uses OAuth browser login instead of API key paste. */
  oauth?: boolean;
};

// Firecrawl first (recommended), then the rest alphabetically.
export const SEARCH_PROVIDER_OPTIONS: readonly SearchProviderEntry[] = [
  {
    value: "firecrawl",
    label: "\uD83D\uDD25 Firecrawl",
    hint: "Recommended · free 10,000 credits · search + scrape",
    envKeys: ["FIRECRAWL_API_KEY"],
    placeholder: "fc-...",
    signupUrl: "https://www.firecrawl.dev/",
    oauth: true,
  },
  {
    value: "brave",
    label: "Brave Search",
    hint: "Structured results · country/language/time filters",
    envKeys: ["BRAVE_API_KEY"],
    placeholder: "BSA...",
    signupUrl: "https://brave.com/search/api/",
  },
  {
    value: "gemini",
    label: "Gemini (Google Search)",
    hint: "Google Search grounding · AI-synthesized",
    envKeys: ["GEMINI_API_KEY"],
    placeholder: "AIza...",
    signupUrl: "https://aistudio.google.com/apikey",
  },
  {
    value: "grok",
    label: "Grok (xAI)",
    hint: "xAI web-grounded responses",
    envKeys: ["XAI_API_KEY"],
    placeholder: "xai-...",
    signupUrl: "https://console.x.ai/",
  },
  {
    value: "kimi",
    label: "Kimi (Moonshot)",
    hint: "Moonshot web search",
    envKeys: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
    placeholder: "sk-...",
    signupUrl: "https://platform.moonshot.cn/",
  },
  {
    value: "perplexity",
    label: "Perplexity Search",
    hint: "Structured results · domain/country/language/time filters",
    envKeys: ["PERPLEXITY_API_KEY"],
    placeholder: "pplx-...",
    signupUrl: "https://www.perplexity.ai/settings/api",
  },
] as const;

export function hasKeyInEnv(entry: SearchProviderEntry): boolean {
  return entry.envKeys.some((k) => Boolean(process.env[k]?.trim()));
}

function rawKeyValue(config: OpenClawConfig, provider: SearchProvider): unknown {
  const search = config.tools?.web?.search;
  switch (provider) {
    case "brave":
      return search?.apiKey;
    case "firecrawl":
      return search?.firecrawl?.apiKey;
    case "gemini":
      return search?.gemini?.apiKey;
    case "grok":
      return search?.grok?.apiKey;
    case "kimi":
      return search?.kimi?.apiKey;
    case "perplexity":
      return search?.perplexity?.apiKey;
  }
}

/** Returns the plaintext key string, or undefined for SecretRefs/missing. */
export function resolveExistingKey(
  config: OpenClawConfig,
  provider: SearchProvider,
): string | undefined {
  return normalizeSecretInputString(rawKeyValue(config, provider));
}

/** Returns true if a key is configured (plaintext string or SecretRef). */
export function hasExistingKey(config: OpenClawConfig, provider: SearchProvider): boolean {
  return hasConfiguredSecretInput(rawKeyValue(config, provider));
}

/** Check if Firecrawl is authenticated (config or env). */
export function isFirecrawlAuthenticated(config: OpenClawConfig): boolean {
  const entry = SEARCH_PROVIDER_OPTIONS.find((e) => e.value === "firecrawl");
  return hasExistingKey(config, "firecrawl") || (entry ? hasKeyInEnv(entry) : false);
}

/** Build an env-backed SecretRef for a search provider. */
function buildSearchEnvRef(provider: SearchProvider): SecretRef {
  const entry = SEARCH_PROVIDER_OPTIONS.find((e) => e.value === provider);
  const envVar = entry?.envKeys.find((k) => Boolean(process.env[k]?.trim())) ?? entry?.envKeys[0];
  if (!envVar) {
    throw new Error(
      `No env var mapping for search provider "${provider}" in secret-input-mode=ref.`,
    );
  }
  return { source: "env", provider: DEFAULT_SECRET_PROVIDER_ALIAS, id: envVar };
}

/** Resolve a plaintext key into the appropriate SecretInput based on mode. */
function resolveSearchSecretInput(
  provider: SearchProvider,
  key: string,
  secretInputMode?: SecretInputMode,
): SecretInput {
  const useSecretRefMode = secretInputMode === "ref"; // pragma: allowlist secret
  if (useSecretRefMode) {
    return buildSearchEnvRef(provider);
  }
  return key;
}

export function applySearchKey(
  config: OpenClawConfig,
  provider: SearchProvider,
  key: SecretInput,
): OpenClawConfig {
  const search = { ...config.tools?.web?.search, provider, enabled: true };
  switch (provider) {
    case "brave":
      search.apiKey = key;
      break;
    case "firecrawl":
      search.firecrawl = { ...search.firecrawl, apiKey: key };
      break;
    case "gemini":
      search.gemini = { ...search.gemini, apiKey: key };
      break;
    case "grok":
      search.grok = { ...search.grok, apiKey: key };
      break;
    case "kimi":
      search.kimi = { ...search.kimi, apiKey: key };
      break;
    case "perplexity":
      search.perplexity = { ...search.perplexity, apiKey: key };
      break;
  }
  return {
    ...config,
    tools: {
      ...config.tools,
      web: { ...config.tools?.web, search },
    },
  };
}

/** Apply Firecrawl key to both search and fetch config. */
export function applyFirecrawlKeyEverywhere(
  config: OpenClawConfig,
  apiKey: string,
): OpenClawConfig {
  return {
    ...config,
    tools: {
      ...config.tools,
      web: {
        ...config.tools?.web,
        search: {
          ...config.tools?.web?.search,
          provider: "firecrawl" as const,
          enabled: true,
          firecrawl: {
            ...config.tools?.web?.search?.firecrawl,
            apiKey,
          },
        },
        fetch: {
          ...config.tools?.web?.fetch,
          provider: "firecrawl" as const,
          firecrawl: {
            ...config.tools?.web?.fetch?.firecrawl,
            enabled: true,
            apiKey,
          },
        },
      },
    },
  };
}

function applyProviderOnly(config: OpenClawConfig, provider: SearchProvider): OpenClawConfig {
  return {
    ...config,
    tools: {
      ...config.tools,
      web: {
        ...config.tools?.web,
        search: {
          ...config.tools?.web?.search,
          provider,
          enabled: true,
        },
      },
    },
  };
}

function preserveDisabledState(original: OpenClawConfig, result: OpenClawConfig): OpenClawConfig {
  if (original.tools?.web?.search?.enabled !== false) {
    return result;
  }
  return {
    ...result,
    tools: {
      ...result.tools,
      web: { ...result.tools?.web, search: { ...result.tools?.web?.search, enabled: false } },
    },
  };
}

// ---------------------------------------------------------------------------
// Firecrawl PKCE OAuth helpers
// ---------------------------------------------------------------------------

function generateSessionId(): string {
  return crypto.randomBytes(32).toString("hex");
}

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  const digest = crypto.createHash("sha256").update(verifier).digest();
  return digest.toString("base64url");
}

const FIRECRAWL_AUTH_STATUS_URL = "https://firecrawl.dev/api/auth/cli/status";
const FIRECRAWL_AUTH_URL_BASE = "https://firecrawl.dev/cli-auth";
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1_000;

type FirecrawlAuthResult = {
  apiKey: string;
  teamName?: string;
};

async function pollFirecrawlAuthStatus(
  sessionId: string,
  codeVerifier: string,
): Promise<FirecrawlAuthResult | null> {
  const res = await fetch(FIRECRAWL_AUTH_STATUS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, code_verifier: codeVerifier }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    return null;
  }
  const data = (await res.json()) as { apiKey?: string; teamName?: string };
  if (data.apiKey) {
    return { apiKey: data.apiKey, teamName: data.teamName };
  }
  return null;
}

async function waitForFirecrawlAuth(
  sessionId: string,
  codeVerifier: string,
  spin: { update: (msg: string) => void },
): Promise<FirecrawlAuthResult | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let dots = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    dots = (dots + 1) % 4;
    spin.update(`Waiting for browser login${".".repeat(dots)}`);
    try {
      const result = await pollFirecrawlAuthStatus(sessionId, codeVerifier);
      if (result) {
        return result;
      }
    } catch {
      // Network blip — keep polling.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Firecrawl OAuth flow
// ---------------------------------------------------------------------------

async function runFirecrawlOAuth(
  config: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  try {
    const sessionId = generateSessionId();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    const authUrl = `${FIRECRAWL_AUTH_URL_BASE}?code_challenge=${codeChallenge}&source=openclaw#session_id=${sessionId}`;

    const isRemote = isRemoteEnvironment();
    if (isRemote) {
      await prompter.note(`Open this URL in your browser to log in:\n\n${authUrl}`, "Firecrawl");
    } else {
      const opened = await openUrl(authUrl);
      if (!opened) {
        await prompter.note(
          `Could not open browser. Visit this URL to log in:\n\n${authUrl}`,
          "Firecrawl",
        );
      }
    }

    const spin = prompter.progress("Waiting for browser login...");
    const result = await waitForFirecrawlAuth(sessionId, codeVerifier, spin);

    if (!result) {
      spin.stop("Timed out waiting for login.");
      await prompter.note(
        "Authentication timed out.\nYou can set up Firecrawl later via `openclaw configure --section web`\nor set the FIRECRAWL_API_KEY environment variable.",
        "Firecrawl",
      );
      return config;
    }

    const teamNote = result.teamName ? ` (team: ${result.teamName})` : "";
    spin.stop(`Authenticated with Firecrawl${teamNote}`);
    return applyFirecrawlKeyEverywhere(config, result.apiKey);
  } catch (err) {
    runtime.log("Firecrawl auth error:", err instanceof Error ? err.message : String(err));
    await prompter.note(
      "Something went wrong during Firecrawl setup.\nYou can set up Firecrawl later via `openclaw configure --section web`\nor set the FIRECRAWL_API_KEY environment variable.",
      "Firecrawl",
    );
    return config;
  }
}

// ---------------------------------------------------------------------------
// Main setup function
// ---------------------------------------------------------------------------

export type SetupSearchOptions = {
  quickstartDefaults?: boolean;
  secretInputMode?: SecretInputMode;
};

export async function setupSearch(
  config: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
  opts?: SetupSearchOptions,
): Promise<OpenClawConfig> {
  await prompter.note(
    [
      "Web search lets your agent look things up online.",
      "Choose a provider and paste your API key.",
      "Docs: https://docs.openclaw.ai/tools/web",
    ].join("\n"),
    "Web search",
  );

  const existingProvider = config.tools?.web?.search?.provider;

  const options = SEARCH_PROVIDER_OPTIONS.map((entry) => {
    const configured = hasExistingKey(config, entry.value) || hasKeyInEnv(entry);
    const hint = configured ? `${entry.hint} · configured` : entry.hint;
    return { value: entry.value, label: entry.label, hint };
  });

  const defaultProvider: SearchProvider = (() => {
    if (existingProvider && SEARCH_PROVIDER_OPTIONS.some((e) => e.value === existingProvider)) {
      return existingProvider;
    }
    const detected = SEARCH_PROVIDER_OPTIONS.find(
      (e) => hasExistingKey(config, e.value) || hasKeyInEnv(e),
    );
    if (detected) {
      return detected.value;
    }
    // Default to Firecrawl (first in list, recommended).
    return SEARCH_PROVIDER_OPTIONS[0].value;
  })();

  type PickerValue = SearchProvider | "__skip__";
  const choice = await prompter.select<PickerValue>({
    message: "Search provider",
    options: [
      ...options,
      {
        value: "__skip__" as const,
        label: "Skip for now",
        hint: "Configure later with openclaw configure --section web",
      },
    ],
    initialValue: defaultProvider as PickerValue,
  });

  if (choice === "__skip__") {
    return config;
  }

  const entry = SEARCH_PROVIDER_OPTIONS.find((e) => e.value === choice)!;
  const existingKey = resolveExistingKey(config, choice);
  const keyConfigured = hasExistingKey(config, choice);
  const envAvailable = hasKeyInEnv(entry);

  // Firecrawl: use OAuth browser login flow.
  if (choice === "firecrawl") {
    // Already authenticated — skip OAuth, just apply provider.
    if (keyConfigured || envAvailable) {
      if (opts?.quickstartDefaults) {
        return preserveDisabledState(
          config,
          existingKey
            ? applyFirecrawlKeyEverywhere(config, existingKey)
            : applyProviderOnly(config, choice),
        );
      }
      await prompter.note("Firecrawl already authenticated.", "Firecrawl");
      return existingKey
        ? applyFirecrawlKeyEverywhere(config, existingKey)
        : applyProviderOnly(config, choice);
    }

    // Offer OAuth or manual entry.
    const method = await prompter.select<"browser" | "manual">({
      message: "How would you like to authenticate?",
      options: [
        { value: "browser", label: "Browser login", hint: "recommended — opens firecrawl.dev" },
        { value: "manual", label: "Paste API key", hint: "if you already have one" },
      ],
      initialValue: "browser",
    });

    if (method === "browser") {
      return runFirecrawlOAuth(config, runtime, prompter);
    }

    // Manual entry for firecrawl.
    const keyInput = await prompter.text({
      message: "Firecrawl API key",
      placeholder: "fc-...",
    });
    const key = keyInput?.trim() ?? "";
    if (key) {
      return applyFirecrawlKeyEverywhere(config, key);
    }
    await prompter.note(
      "No API key stored — web_search won't work until a key is available.\nGet your key at: https://www.firecrawl.dev/\nDocs: https://docs.openclaw.ai/tools/web",
      "Web search",
    );
    return config;
  }

  // Non-firecrawl providers: standard API key paste flow.
  if (opts?.quickstartDefaults && (keyConfigured || envAvailable)) {
    const result = existingKey
      ? applySearchKey(config, choice, existingKey)
      : applyProviderOnly(config, choice);
    return preserveDisabledState(config, result);
  }

  const useSecretRefMode = opts?.secretInputMode === "ref"; // pragma: allowlist secret
  if (useSecretRefMode) {
    if (keyConfigured) {
      return preserveDisabledState(config, applyProviderOnly(config, choice));
    }
    const ref = buildSearchEnvRef(choice);
    await prompter.note(
      [
        "Secret references enabled — OpenClaw will store a reference instead of the API key.",
        `Env var: ${ref.id}${envAvailable ? " (detected)" : ""}.`,
        ...(envAvailable ? [] : [`Set ${ref.id} in the Gateway environment.`]),
        "Docs: https://docs.openclaw.ai/tools/web",
      ].join("\n"),
      "Web search",
    );
    return applySearchKey(config, choice, ref);
  }

  const keyInput = await prompter.text({
    message: keyConfigured
      ? `${entry.label} API key (leave blank to keep current)`
      : envAvailable
        ? `${entry.label} API key (leave blank to use env var)`
        : `${entry.label} API key`,
    placeholder: keyConfigured ? "Leave blank to keep current" : entry.placeholder,
  });

  const key = keyInput?.trim() ?? "";
  if (key) {
    const secretInput = resolveSearchSecretInput(choice, key, opts?.secretInputMode);
    return applySearchKey(config, choice, secretInput);
  }

  if (existingKey) {
    return preserveDisabledState(config, applySearchKey(config, choice, existingKey));
  }

  if (keyConfigured || envAvailable) {
    return preserveDisabledState(config, applyProviderOnly(config, choice));
  }

  await prompter.note(
    [
      "No API key stored — web_search won't work until a key is available.",
      `Get your key at: ${entry.signupUrl}`,
      "Docs: https://docs.openclaw.ai/tools/web",
    ].join("\n"),
    "Web search",
  );

  return {
    ...config,
    tools: {
      ...config.tools,
      web: {
        ...config.tools?.web,
        search: {
          ...config.tools?.web?.search,
          provider: choice,
        },
      },
    },
  };
}
