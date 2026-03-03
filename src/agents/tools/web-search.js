import { Type } from "@sinclair/typebox";
import { formatCliCommand } from "../../cli/command-format.js";
import { logVerbose } from "../../globals.js";
import { wrapWebContent } from "../../security/external-content.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import { withTrustedWebToolsEndpoint } from "./web-guarded-fetch.js";
import { resolveCitationRedirectUrl } from "./web-search-citation-redirect.js";
import { DEFAULT_CACHE_TTL_MINUTES, DEFAULT_TIMEOUT_SECONDS, normalizeCacheKey, readCache, readResponseText, resolveCacheTtlMs, resolveTimeoutSeconds, writeCache, } from "./web-shared.js";
const SEARCH_PROVIDERS = ["brave", "perplexity", "grok", "duckduckgo", "gemini", "kimi"];
const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;
const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_PERPLEXITY_BASE_URL = "https://openrouter.ai/api/v1";
const PERPLEXITY_DIRECT_BASE_URL = "https://api.perplexity.ai";
const DEFAULT_PERPLEXITY_MODEL = "perplexity/sonar-pro";
const PERPLEXITY_KEY_PREFIXES = ["pplx-"];
const OPENROUTER_KEY_PREFIXES = ["sk-or-"];
const XAI_API_ENDPOINT = "https://api.x.ai/v1/responses";
const DEFAULT_GROK_MODEL = "grok-4-1-fast";
const DEFAULT_KIMI_BASE_URL = "https://api.moonshot.ai/v1";
const DEFAULT_KIMI_MODEL = "moonshot-v1-128k";
const KIMI_WEB_SEARCH_TOOL = {
    type: "builtin_function",
    function: { name: "$web_search" },
};
const DUCKDUCKGO_API_ENDPOINT = "https://api.duckduckgo.com";
const SEARCH_CACHE = new Map();
const BRAVE_FRESHNESS_SHORTCUTS = new Set(["pd", "pw", "pm", "py"]);
const BRAVE_FRESHNESS_RANGE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/;
const BRAVE_SEARCH_LANG_CODE = /^[a-z]{2}$/i;
const BRAVE_UI_LANG_LOCALE = /^([a-z]{2})-([a-z]{2})$/i;
const TRUSTED_NETWORK_SSRF_POLICY = { dangerouslyAllowPrivateNetwork: true };
const WebSearchSchema = Type.Object({
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(Type.Number({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: MAX_SEARCH_COUNT,
    })),
    country: Type.Optional(Type.String({
        description: "2-letter country code for region-specific results (e.g., 'DE', 'US', 'ALL'). Default: 'US'.",
    })),
    search_lang: Type.Optional(Type.String({
        description: "Short ISO language code for search results (e.g., 'de', 'en', 'fr', 'tr'). Must be a 2-letter code, NOT a locale.",
    })),
    ui_lang: Type.Optional(Type.String({
        description: "Locale code for UI elements in language-region format (e.g., 'en-US', 'de-DE', 'fr-FR', 'tr-TR'). Must include region subtag.",
    })),
    freshness: Type.Optional(Type.String({
        description: "Filter results by discovery time. Brave supports 'pd', 'pw', 'pm', 'py', and date range 'YYYY-MM-DDtoYYYY-MM-DD'. Perplexity supports 'pd', 'pw', 'pm', and 'py'.",
    })),
});
function extractGrokContent(data) {
    // xAI Responses API format: find the message output with text content
    for (const output of data.output ?? []) {
        if (output.type === "message") {
            for (const block of output.content ?? []) {
                if (block.type === "output_text" && typeof block.text === "string" && block.text) {
                    const urls = (block.annotations ?? [])
                        .filter((a) => a.type === "url_citation" && typeof a.url === "string")
                        .map((a) => a.url);
                    return { text: block.text, annotationCitations: [...new Set(urls)] };
                }
            }
        }
        // Some xAI responses place output_text blocks directly in the output array
        // without a message wrapper.
        if (output.type === "output_text" &&
            "text" in output &&
            typeof output.text === "string" &&
            output.text) {
            const rawAnnotations = "annotations" in output && Array.isArray(output.annotations) ? output.annotations : [];
            const urls = rawAnnotations
                .filter((a) => a.type === "url_citation" && typeof a.url === "string")
                .map((a) => a.url);
            return { text: output.text, annotationCitations: [...new Set(urls)] };
        }
    }
    // Fallback: deprecated output_text field
    const text = typeof data.output_text === "string" ? data.output_text : undefined;
    return { text, annotationCitations: [] };
}
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
function resolveSearchConfig(cfg) {
    const search = cfg?.tools?.web?.search;
    if (!search || typeof search !== "object") {
        return undefined;
    }
    return search;
}
function resolveSearchEnabled(params) {
    if (typeof params.search?.enabled === "boolean") {
        return params.search.enabled;
    }
    if (params.sandboxed) {
        return true;
    }
    return true;
}
function resolveSearchApiKey(search) {
    const fromConfig = search && "apiKey" in search && typeof search.apiKey === "string"
        ? normalizeSecretInput(search.apiKey)
        : "";
    const fromEnv = normalizeSecretInput(process.env.BRAVE_API_KEY);
    return fromConfig || fromEnv || undefined;
}
function missingSearchKeyPayload(provider) {
    if (provider === "perplexity") {
        return {
            error: "missing_perplexity_api_key",
            message: "web_search (perplexity) needs an API key. Set PERPLEXITY_API_KEY or OPENROUTER_API_KEY in the Gateway environment, or configure tools.web.search.perplexity.apiKey.",
            docs: "https://docs.openclaw.ai/tools/web",
        };
    }
    if (provider === "grok") {
        return {
            error: "missing_xai_api_key",
            message: "web_search (grok) needs an xAI API key. Set XAI_API_KEY in the Gateway environment, or configure tools.web.search.grok.apiKey.",
            docs: "https://docs.openclaw.ai/tools/web",
        };
    }
    if (provider === "duckduckgo") {
        return {
            error: "duckduckgo_unavailable",
            message: "web_search (duckduckgo) is unavailable. The service may be down or blocked.",
            docs: "https://docs.openclaw.ai/tools/web",
        };
    }
    if (provider === "gemini") {
        return {
            error: "missing_gemini_api_key",
            message: "web_search (gemini) needs an API key. Set GEMINI_API_KEY in the Gateway environment, or configure tools.web.search.gemini.apiKey.",
            docs: "https://docs.openclaw.ai/tools/web",
        };
    }
    if (provider === "kimi") {
        return {
            error: "missing_kimi_api_key",
            message: "web_search (kimi) needs a Moonshot API key. Set KIMI_API_KEY or MOONSHOT_API_KEY in the Gateway environment, or configure tools.web.search.kimi.apiKey.",
            docs: "https://docs.openclaw.ai/tools/web",
        };
    }
    return {
        error: "missing_brave_api_key",
        message: `web_search needs a Brave Search API key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set BRAVE_API_KEY in the Gateway environment.`,
        docs: "https://docs.openclaw.ai/tools/web",
    };
}
function resolveSearchProvider(search) {
    const raw = search && "provider" in search && typeof search.provider === "string"
        ? search.provider.trim().toLowerCase()
        : "";
    if (raw === "perplexity") {
        return "perplexity";
    }
    if (raw === "grok") {
        return "grok";
    }
    if (raw === "duckduckgo") {
        return "duckduckgo";
    }
    if (raw === "gemini") {
        return "gemini";
    }
    if (raw === "kimi") {
        return "kimi";
    }
    if (raw === "brave") {
        return "brave";
    }
    // Auto-detect provider from available API keys (priority order)
    if (raw === "") {
        // 1. Brave
        if (resolveSearchApiKey(search)) {
            logVerbose('web_search: no provider configured, auto-detected "brave" from available API keys');
            return "brave";
        }
        // 2. Gemini
        const geminiConfig = resolveGeminiConfig(search);
        if (resolveGeminiApiKey(geminiConfig)) {
            logVerbose('web_search: no provider configured, auto-detected "gemini" from available API keys');
            return "gemini";
        }
        // 3. Kimi
        const kimiConfig = resolveKimiConfig(search);
        if (resolveKimiApiKey(kimiConfig)) {
            logVerbose('web_search: no provider configured, auto-detected "kimi" from available API keys');
            return "kimi";
        }
        // 4. Perplexity
        const perplexityConfig = resolvePerplexityConfig(search);
        const { apiKey: perplexityKey } = resolvePerplexityApiKey(perplexityConfig);
        if (perplexityKey) {
            logVerbose('web_search: no provider configured, auto-detected "perplexity" from available API keys');
            return "perplexity";
        }
        // 5. Grok
        const grokConfig = resolveGrokConfig(search);
        if (resolveGrokApiKey(grokConfig)) {
            logVerbose('web_search: no provider configured, auto-detected "grok" from available API keys');
            return "grok";
        }
    }
    return "brave";
}
function resolvePerplexityConfig(search) {
    if (!search || typeof search !== "object") {
        return {};
    }
    const perplexity = "perplexity" in search ? search.perplexity : undefined;
    if (!perplexity || typeof perplexity !== "object") {
        return {};
    }
    return perplexity;
}
function resolvePerplexityApiKey(perplexity) {
    const fromConfig = normalizeApiKey(perplexity?.apiKey);
    if (fromConfig) {
        return { apiKey: fromConfig, source: "config" };
    }
    const fromEnvPerplexity = normalizeApiKey(process.env.PERPLEXITY_API_KEY);
    if (fromEnvPerplexity) {
        return { apiKey: fromEnvPerplexity, source: "perplexity_env" };
    }
    const fromEnvOpenRouter = normalizeApiKey(process.env.OPENROUTER_API_KEY);
    if (fromEnvOpenRouter) {
        return { apiKey: fromEnvOpenRouter, source: "openrouter_env" };
    }
    return { apiKey: undefined, source: "none" };
}
function normalizeApiKey(key) {
    return normalizeSecretInput(key);
}
function inferPerplexityBaseUrlFromApiKey(apiKey) {
    if (!apiKey) {
        return undefined;
    }
    const normalized = apiKey.toLowerCase();
    if (PERPLEXITY_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
        return "direct";
    }
    if (OPENROUTER_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
        return "openrouter";
    }
    return undefined;
}
function resolvePerplexityBaseUrl(perplexity, apiKeySource = "none", apiKey) {
    const fromConfig = perplexity && "baseUrl" in perplexity && typeof perplexity.baseUrl === "string"
        ? perplexity.baseUrl.trim()
        : "";
    if (fromConfig) {
        return fromConfig;
    }
    if (apiKeySource === "perplexity_env") {
        return PERPLEXITY_DIRECT_BASE_URL;
    }
    if (apiKeySource === "openrouter_env") {
        return DEFAULT_PERPLEXITY_BASE_URL;
    }
    if (apiKeySource === "config") {
        const inferred = inferPerplexityBaseUrlFromApiKey(apiKey);
        if (inferred === "direct") {
            return PERPLEXITY_DIRECT_BASE_URL;
        }
        if (inferred === "openrouter") {
            return DEFAULT_PERPLEXITY_BASE_URL;
        }
    }
    return DEFAULT_PERPLEXITY_BASE_URL;
}
function resolvePerplexityModel(perplexity) {
    const fromConfig = perplexity && "model" in perplexity && typeof perplexity.model === "string"
        ? perplexity.model.trim()
        : "";
    return fromConfig || DEFAULT_PERPLEXITY_MODEL;
}
function isDirectPerplexityBaseUrl(baseUrl) {
    const trimmed = baseUrl.trim();
    if (!trimmed) {
        return false;
    }
    try {
        return new URL(trimmed).hostname.toLowerCase() === "api.perplexity.ai";
    }
    catch {
        return false;
    }
}
function resolvePerplexityRequestModel(baseUrl, model) {
    if (!isDirectPerplexityBaseUrl(baseUrl)) {
        return model;
    }
    return model.startsWith("perplexity/") ? model.slice("perplexity/".length) : model;
}
function resolveGrokConfig(search) {
    if (!search || typeof search !== "object") {
        return {};
    }
    const grok = "grok" in search ? search.grok : undefined;
    if (!grok || typeof grok !== "object") {
        return {};
    }
    return grok;
}
function resolveGrokApiKey(grok) {
    const fromConfig = normalizeApiKey(grok?.apiKey);
    if (fromConfig) {
        return fromConfig;
    }
    const fromEnv = normalizeApiKey(process.env.XAI_API_KEY);
    return fromEnv || undefined;
}
function resolveGrokModel(grok) {
    const fromConfig = grok && "model" in grok && typeof grok.model === "string" ? grok.model.trim() : "";
    return fromConfig || DEFAULT_GROK_MODEL;
}
function resolveGrokInlineCitations(grok) {
    return grok?.inlineCitations === true;
}
function resolveKimiConfig(search) {
    if (!search || typeof search !== "object") {
        return {};
    }
    const kimi = "kimi" in search ? search.kimi : undefined;
    if (!kimi || typeof kimi !== "object") {
        return {};
    }
    return kimi;
}
function resolveKimiApiKey(kimi) {
    const fromConfig = normalizeApiKey(kimi?.apiKey);
    if (fromConfig) {
        return fromConfig;
    }
    const fromEnvKimi = normalizeApiKey(process.env.KIMI_API_KEY);
    if (fromEnvKimi) {
        return fromEnvKimi;
    }
    const fromEnvMoonshot = normalizeApiKey(process.env.MOONSHOT_API_KEY);
    return fromEnvMoonshot || undefined;
}
function resolveKimiModel(kimi) {
    const fromConfig = kimi && "model" in kimi && typeof kimi.model === "string" ? kimi.model.trim() : "";
    return fromConfig || DEFAULT_KIMI_MODEL;
}
function resolveKimiBaseUrl(kimi) {
    const fromConfig = kimi && "baseUrl" in kimi && typeof kimi.baseUrl === "string" ? kimi.baseUrl.trim() : "";
    return fromConfig || DEFAULT_KIMI_BASE_URL;
}
function resolveGeminiConfig(search) {
    if (!search || typeof search !== "object") {
        return {};
    }
    const gemini = "gemini" in search ? search.gemini : undefined;
    if (!gemini || typeof gemini !== "object") {
        return {};
    }
    return gemini;
}
function resolveGeminiApiKey(gemini) {
    const fromConfig = normalizeApiKey(gemini?.apiKey);
    if (fromConfig) {
        return fromConfig;
    }
    const fromEnv = normalizeApiKey(process.env.GEMINI_API_KEY);
    return fromEnv || undefined;
}
function resolveGeminiModel(gemini) {
    const fromConfig = gemini && "model" in gemini && typeof gemini.model === "string" ? gemini.model.trim() : "";
    return fromConfig || DEFAULT_GEMINI_MODEL;
}
async function withTrustedWebSearchEndpoint(params, run) {
    return withTrustedWebToolsEndpoint({
        url: params.url,
        init: params.init,
        timeoutSeconds: params.timeoutSeconds,
    }, async ({ response }) => run(response));
}
async function runGeminiSearch(params) {
    const endpoint = `${GEMINI_API_BASE}/models/${params.model}:generateContent`;
    return withTrustedWebSearchEndpoint({
        url: endpoint,
        timeoutSeconds: params.timeoutSeconds,
        init: {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": params.apiKey,
            },
            body: JSON.stringify({
                contents: [
                    {
                        parts: [{ text: params.query }],
                    },
                ],
                tools: [{ google_search: {} }],
            }),
        },
    }, async (res) => {
        if (!res.ok) {
            const detailResult = await readResponseText(res, { maxBytes: 64000 });
            // Strip API key from any error detail to prevent accidental key leakage in logs
            const safeDetail = (detailResult.text || res.statusText).replace(/key=[^&\s]+/gi, "key=***");
            throw new Error(`Gemini API error (${res.status}): ${safeDetail}`);
        }
        let data;
        try {
            data = (await res.json());
        }
        catch (err) {
            const safeError = String(err).replace(/key=[^&\s]+/gi, "key=***");
            throw new Error(`Gemini API returned invalid JSON: ${safeError}`, { cause: err });
        }
        if (data.error) {
            const rawMsg = data.error.message || data.error.status || "unknown";
            const safeMsg = rawMsg.replace(/key=[^&\s]+/gi, "key=***");
            throw new Error(`Gemini API error (${data.error.code}): ${safeMsg}`);
        }
        const candidate = data.candidates?.[0];
        const content = candidate?.content?.parts
            ?.map((p) => p.text)
            .filter(Boolean)
            .join("\n") ?? "No response";
        const groundingChunks = candidate?.groundingMetadata?.groundingChunks ?? [];
        const rawCitations = groundingChunks
            .filter((chunk) => chunk.web?.uri)
            .map((chunk) => ({
            url: chunk.web.uri,
            title: chunk.web?.title || undefined,
        }));
        // Resolve Google grounding redirect URLs to direct URLs with concurrency cap.
        // Gemini typically returns 3-8 citations; cap at 10 concurrent to be safe.
        const MAX_CONCURRENT_REDIRECTS = 10;
        const citations = [];
        for (let i = 0; i < rawCitations.length; i += MAX_CONCURRENT_REDIRECTS) {
            const batch = rawCitations.slice(i, i + MAX_CONCURRENT_REDIRECTS);
            const resolved = await Promise.all(batch.map(async (citation) => {
                const resolvedUrl = await resolveCitationRedirectUrl(citation.url);
                return { ...citation, url: resolvedUrl };
            }));
            citations.push(...resolved);
        }
        return { content, citations };
    });
}
// resolveCitationRedirectUrl is now imported from its own module
function resolveSearchCount(value, fallback) {
    const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
    const clamped = Math.max(1, Math.min(MAX_SEARCH_COUNT, Math.floor(parsed)));
    return clamped;
}
function normalizeBraveSearchLang(value) {
    if (!value) {
        return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed || !BRAVE_SEARCH_LANG_CODE.test(trimmed)) {
        return undefined;
    }
    return trimmed.toLowerCase();
}
function normalizeBraveUiLang(value) {
    if (!value) {
        return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    const match = trimmed.match(BRAVE_UI_LANG_LOCALE);
    if (!match) {
        return undefined;
    }
    const [, language, region] = match;
    return `${language.toLowerCase()}-${region.toUpperCase()}`;
}
function normalizeBraveLanguageParams(params) {
    const rawSearchLang = params.search_lang?.trim() || undefined;
    const rawUiLang = params.ui_lang?.trim() || undefined;
    let searchLangCandidate = rawSearchLang;
    let uiLangCandidate = rawUiLang;
    // Recover common LLM mix-up: locale in search_lang + short code in ui_lang.
    if (normalizeBraveUiLang(rawSearchLang) && normalizeBraveSearchLang(rawUiLang)) {
        searchLangCandidate = rawUiLang;
        uiLangCandidate = rawSearchLang;
    }
    const search_lang = normalizeBraveSearchLang(searchLangCandidate);
    if (searchLangCandidate && !search_lang) {
        return { invalidField: "search_lang" };
    }
    const ui_lang = normalizeBraveUiLang(uiLangCandidate);
    if (uiLangCandidate && !ui_lang) {
        return { invalidField: "ui_lang" };
    }
    return { search_lang, ui_lang };
}
function normalizeFreshness(value) {
    if (!value) {
        return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    const lower = trimmed.toLowerCase();
    if (BRAVE_FRESHNESS_SHORTCUTS.has(lower)) {
        return lower;
    }
    const match = trimmed.match(BRAVE_FRESHNESS_RANGE);
    if (!match) {
        return undefined;
    }
    const [, start, end] = match;
    if (!isValidIsoDate(start) || !isValidIsoDate(end)) {
        return undefined;
    }
    if (start > end) {
        return undefined;
    }
    return `${start}to${end}`;
}
/**
 * Map normalized freshness values (pd/pw/pm/py) to Perplexity's
 * search_recency_filter values (day/week/month/year).
 */
function freshnessToPerplexityRecency(freshness) {
    if (!freshness) {
        return undefined;
    }
    const map = {
        pd: "day",
        pw: "week",
        pm: "month",
        py: "year",
    };
    return map[freshness] ?? undefined;
}
function isValidIsoDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }
    const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
        return false;
    }
    const date = new Date(Date.UTC(year, month - 1, day));
    return (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day);
}
function resolveSiteName(url) {
    if (!url) {
        return undefined;
    }
    try {
        return new URL(url).hostname;
    }
    catch {
        return undefined;
    }
}
async function throwWebSearchApiError(res, providerLabel) {
    const detailResult = await readResponseText(res, { maxBytes: 64000 });
    const detail = detailResult.text;
    throw new Error(`${providerLabel} API error (${res.status}): ${detail || res.statusText}`);
}
async function runDuckDuckGoSearch(params) {
    const url = new URL(DUCKDUCKGO_API_ENDPOINT);
    url.searchParams.set("q", params.query);
    url.searchParams.set("format", "json");
    url.searchParams.set("no_html", "1");
    url.searchParams.set("skip_disambig", "1");
    return withTrustedWebSearchEndpoint({
        url: url.toString(),
        timeoutSeconds: params.timeoutSeconds,
        init: {
            method: "GET",
        },
    }, async (res) => {
        if (!res.ok) {
            return throwWebSearchApiError(res, "DuckDuckGo");
        }
        const data = (await res.json());
        const results = [];
        const topics = data.RelatedTopics ?? [];
        for (const topic of topics) {
            if (topic.FirstURL && topic.Text) {
                results.push({
                    title: topic.Text.split(" - ")[0] || "",
                    url: topic.FirstURL,
                    snippet: topic.Text,
                });
                if (results.length >= params.count) {
                    break;
                }
            }
        }
        const results2 = data.Results ?? [];
        for (const topic of results2) {
            if (topic.FirstURL && topic.Text) {
                results.push({
                    title: topic.Text.split(" - ")[0] || "",
                    url: topic.FirstURL,
                    snippet: topic.Text,
                });
                if (results.length >= params.count) {
                    break;
                }
            }
        }
        if (results.length === 0 && data.AbstractText) {
            results.push({
                title: data.Heading || data.AbstractURL || "",
                url: data.AbstractURL || "",
                snippet: data.AbstractText,
            });
        }
        return results.slice(0, params.count);
    });
}
async function runPerplexitySearch(params) {
    const baseUrl = params.baseUrl.trim().replace(/\/$/, "");
    const endpoint = `${baseUrl}/chat/completions`;
    const model = resolvePerplexityRequestModel(baseUrl, params.model);
    const body = {
        model,
        messages: [
            {
                role: "user",
                content: params.query,
            },
        ],
    };
    const recencyFilter = freshnessToPerplexityRecency(params.freshness);
    if (recencyFilter) {
        body.search_recency_filter = recencyFilter;
    }
    return withTrustedWebSearchEndpoint({
        url: endpoint,
        timeoutSeconds: params.timeoutSeconds,
        init: {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${params.apiKey}`,
                "HTTP-Referer": "https://openclaw.ai",
                "X-Title": "OpenClaw Web Search",
            },
            body: JSON.stringify(body),
        },
    }, async (res) => {
        if (!res.ok) {
            return throwWebSearchApiError(res, "Perplexity");
        }
        const data = (await res.json());
        const content = data.choices?.[0]?.message?.content ?? "No response";
        const citations = data.citations ?? [];
        return { content, citations };
    });
}
async function runGrokSearch(params) {
    const body = {
        model: params.model,
        input: [
            {
                role: "user",
                content: params.query,
            },
        ],
        tools: [{ type: "web_search" }],
    };
    // Note: xAI's /v1/responses endpoint does not support the `include`
    // parameter (returns 400 "Argument not supported: include"). Inline
    // citations are returned automatically when available — we just parse
    // them from the response without requesting them explicitly (#12910).
    return withTrustedWebSearchEndpoint({
        url: XAI_API_ENDPOINT,
        timeoutSeconds: params.timeoutSeconds,
        init: {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${params.apiKey}`,
            },
            body: JSON.stringify(body),
        },
    }, async (res) => {
        if (!res.ok) {
            return throwWebSearchApiError(res, "xAI");
        }
        const data = (await res.json());
        const { text: extractedText, annotationCitations } = extractGrokContent(data);
        const content = extractedText ?? "No response";
        // Prefer top-level citations; fall back to annotation-derived ones
        const citations = (data.citations ?? []).length > 0 ? data.citations : annotationCitations;
        const inlineCitations = data.inline_citations;
        return { content, citations, inlineCitations };
    });
}
function extractKimiMessageText(message) {
    const content = message?.content?.trim();
    if (content) {
        return content;
    }
    const reasoning = message?.reasoning_content?.trim();
    return reasoning || undefined;
}
function extractKimiCitations(data) {
    const citations = (data.search_results ?? [])
        .map((entry) => entry.url?.trim())
        .filter((url) => Boolean(url));
    for (const toolCall of data.choices?.[0]?.message?.tool_calls ?? []) {
        const rawArguments = toolCall.function?.arguments;
        if (!rawArguments) {
            continue;
        }
        try {
            const parsed = JSON.parse(rawArguments);
            if (typeof parsed.url === "string" && parsed.url.trim()) {
                citations.push(parsed.url.trim());
            }
            for (const result of parsed.search_results ?? []) {
                if (typeof result.url === "string" && result.url.trim()) {
                    citations.push(result.url.trim());
                }
            }
        }
        catch {
            // ignore malformed tool arguments
        }
    }
    return [...new Set(citations)];
}
function buildKimiToolResultContent(data) {
    return JSON.stringify({
        search_results: (data.search_results ?? []).map((entry) => ({
            title: entry.title ?? "",
            url: entry.url ?? "",
            content: entry.content ?? "",
        })),
    });
}
async function runKimiSearch(params) {
    const baseUrl = params.baseUrl.trim().replace(/\/$/, "");
    const endpoint = `${baseUrl}/chat/completions`;
    const messages = [
        {
            role: "user",
            content: params.query,
        },
    ];
    const collectedCitations = new Set();
    const MAX_ROUNDS = 3;
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const nextResult = await withTrustedWebSearchEndpoint({
            url: endpoint,
            timeoutSeconds: params.timeoutSeconds,
            init: {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${params.apiKey}`,
                },
                body: JSON.stringify({
                    model: params.model,
                    messages,
                    tools: [KIMI_WEB_SEARCH_TOOL],
                }),
            },
        }, async (res) => {
            if (!res.ok) {
                return throwWebSearchApiError(res, "Kimi");
            }
            const data = (await res.json());
            for (const citation of extractKimiCitations(data)) {
                collectedCitations.add(citation);
            }
            const choice = data.choices?.[0];
            const message = choice?.message;
            const text = extractKimiMessageText(message);
            const toolCalls = message?.tool_calls ?? [];
            if (choice?.finish_reason !== "tool_calls" || toolCalls.length === 0) {
                return { done: true, content: text ?? "No response", citations: [...collectedCitations] };
            }
            messages.push({
                role: "assistant",
                content: message?.content ?? "",
                ...(message?.reasoning_content
                    ? {
                        reasoning_content: message.reasoning_content,
                    }
                    : {}),
                tool_calls: toolCalls,
            });
            const toolContent = buildKimiToolResultContent(data);
            let pushedToolResult = false;
            for (const toolCall of toolCalls) {
                const toolCallId = toolCall.id?.trim();
                if (!toolCallId) {
                    continue;
                }
                pushedToolResult = true;
                messages.push({
                    role: "tool",
                    tool_call_id: toolCallId,
                    content: toolContent,
                });
            }
            if (!pushedToolResult) {
                return { done: true, content: text ?? "No response", citations: [...collectedCitations] };
            }
            return { done: false };
        });
        if (nextResult.done) {
            return { content: nextResult.content ?? "No response", citations: nextResult.citations ?? [] };
        }
    }
    return {
        content: "Search completed but no final answer was produced.",
        citations: [...collectedCitations],
    };
}
async function runWebSearch(params) {
    const cacheKey = normalizeCacheKey(params.provider === "brave"
        ? `${params.provider}:${params.query}:${params.count}:${params.country || "default"}:${params.search_lang || "default"}:${params.ui_lang || "default"}:${params.freshness || "default"}`
        : params.provider === "perplexity"
            ? `${params.provider}:${params.query}:${params.perplexityBaseUrl ?? DEFAULT_PERPLEXITY_BASE_URL}:${params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL}:${params.freshness || "default"}`
            : params.provider === "kimi"
                ? `${params.provider}:${params.query}:${params.kimiBaseUrl ?? DEFAULT_KIMI_BASE_URL}:${params.kimiModel ?? DEFAULT_KIMI_MODEL}`
                : params.provider === "gemini"
                    ? `${params.provider}:${params.query}:${params.geminiModel ?? DEFAULT_GEMINI_MODEL}`
                    : `${params.provider}:${params.query}:${params.grokModel ?? DEFAULT_GROK_MODEL}:${String(params.grokInlineCitations ?? false)}`);
    const cached = readCache(SEARCH_CACHE, cacheKey);
    if (cached) {
        return { ...cached.value, cached: true };
    }
    const start = Date.now();
    if (params.provider === "perplexity") {
        const { content, citations } = await runPerplexitySearch({
            query: params.query,
            apiKey: params.apiKey,
            baseUrl: params.perplexityBaseUrl ?? DEFAULT_PERPLEXITY_BASE_URL,
            model: params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL,
            timeoutSeconds: params.timeoutSeconds,
            freshness: params.freshness,
        });
        const payload = {
            query: params.query,
            provider: params.provider,
            model: params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL,
            tookMs: Date.now() - start,
            externalContent: {
                untrusted: true,
                source: "web_search",
                provider: params.provider,
                wrapped: true,
            },
            content: wrapWebContent(content),
            citations,
        };
        writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
        return payload;
    }
    if (params.provider === "grok") {
        const { content, citations, inlineCitations } = await runGrokSearch({
            query: params.query,
            apiKey: params.apiKey,
            model: params.grokModel ?? DEFAULT_GROK_MODEL,
            timeoutSeconds: params.timeoutSeconds,
            inlineCitations: params.grokInlineCitations ?? false,
        });
        const payload = {
            query: params.query,
            provider: params.provider,
            model: params.grokModel ?? DEFAULT_GROK_MODEL,
            tookMs: Date.now() - start,
            externalContent: {
                untrusted: true,
                source: "web_search",
                provider: params.provider,
                wrapped: true,
            },
            content: wrapWebContent(content),
            citations,
            inlineCitations,
        };
        writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
        return payload;
    }
    if (params.provider === "duckduckgo") {
        const results = await runDuckDuckGoSearch({
            query: params.query,
            count: params.count,
            timeoutSeconds: params.timeoutSeconds,
        });
        const mapped = results.map((entry) => {
            const description = entry.snippet ?? "";
            const title = entry.title ?? "";
            const url = entry.url ?? "";
            const rawSiteName = resolveSiteName(url);
            return {
                title: title ? wrapWebContent(title, "web_search") : "",
                url,
                description: description ? wrapWebContent(description, "web_search") : "",
                published: entry.published || undefined,
                siteName: rawSiteName || undefined,
            };
        });
        const payload = {
            query: params.query,
            provider: params.provider,
            count: mapped.length,
            tookMs: Date.now() - start,
            externalContent: {
                untrusted: true,
                source: "web_search",
                provider: params.provider,
                wrapped: true,
            },
            results: mapped,
        };
        writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
        return payload;
    }
    if (params.provider === "kimi") {
        const { content, citations } = await runKimiSearch({
            query: params.query,
            apiKey: params.apiKey,
            baseUrl: params.kimiBaseUrl ?? DEFAULT_KIMI_BASE_URL,
            model: params.kimiModel ?? DEFAULT_KIMI_MODEL,
            timeoutSeconds: params.timeoutSeconds,
        });
        const payload = {
            query: params.query,
            provider: params.provider,
            model: params.kimiModel ?? DEFAULT_KIMI_MODEL,
            tookMs: Date.now() - start,
            externalContent: {
                untrusted: true,
                source: "web_search",
                provider: params.provider,
                wrapped: true,
            },
            content: wrapWebContent(content),
            citations,
        };
        writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
        return payload;
    }
    if (params.provider === "gemini") {
        const geminiResult = await runGeminiSearch({
            query: params.query,
            apiKey: params.apiKey,
            model: params.geminiModel ?? DEFAULT_GEMINI_MODEL,
            timeoutSeconds: params.timeoutSeconds,
        });
        const payload = {
            query: params.query,
            provider: params.provider,
            model: params.geminiModel ?? DEFAULT_GEMINI_MODEL,
            tookMs: Date.now() - start,
            externalContent: {
                untrusted: true,
                source: "web_search",
                provider: params.provider,
                wrapped: true,
            },
            content: wrapWebContent(geminiResult.content),
            citations: geminiResult.citations,
        };
        writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
        return payload;
    }
    if (params.provider !== "brave") {
        throw new Error("Unsupported web search provider.");
    }
    const url = new URL(BRAVE_SEARCH_ENDPOINT);
    url.searchParams.set("q", params.query);
    url.searchParams.set("count", String(params.count));
    if (params.country) {
        url.searchParams.set("country", params.country);
    }
    if (params.search_lang) {
        url.searchParams.set("search_lang", params.search_lang);
    }
    if (params.ui_lang) {
        url.searchParams.set("ui_lang", params.ui_lang);
    }
    if (params.freshness) {
        url.searchParams.set("freshness", params.freshness);
    }
    const mapped = await withTrustedWebSearchEndpoint({
        url: url.toString(),
        timeoutSeconds: params.timeoutSeconds,
        init: {
            method: "GET",
            headers: {
                Accept: "application/json",
                "X-Subscription-Token": params.apiKey,
            },
        },
    }, async (res) => {
        if (!res.ok) {
            const detailResult = await readResponseText(res, { maxBytes: 64000 });
            const detail = detailResult.text;
            throw new Error(`Brave Search API error (${res.status}): ${detail || res.statusText}`);
        }
        const data = (await res.json());
        const results = Array.isArray(data.web?.results) ? (data.web?.results ?? []) : [];
        return results.map((entry) => {
            const description = entry.description ?? "";
            const title = entry.title ?? "";
            const url = entry.url ?? "";
            const rawSiteName = resolveSiteName(url);
            return {
                title: title ? wrapWebContent(title, "web_search") : "",
                url, // Keep raw for tool chaining
                description: description ? wrapWebContent(description, "web_search") : "",
                published: entry.age || undefined,
                siteName: rawSiteName || undefined,
            };
        });
    });
    const payload = {
        query: params.query,
        provider: params.provider,
        count: mapped.length,
        tookMs: Date.now() - start,
        externalContent: {
            untrusted: true,
            source: "web_search",
            provider: params.provider,
            wrapped: true,
        },
        results: mapped,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
}
export function createWebSearchTool(options) {
    const search = resolveSearchConfig(options?.config);
    if (!resolveSearchEnabled({ search, sandboxed: options?.sandboxed })) {
        return null;
    }
    const provider = resolveSearchProvider(search);
    const perplexityConfig = resolvePerplexityConfig(search);
    const grokConfig = resolveGrokConfig(search);
    const geminiConfig = resolveGeminiConfig(search);
    const kimiConfig = resolveKimiConfig(search);
    const description = provider === "perplexity"
        ? "Search the web using Perplexity Sonar (direct or via OpenRouter). Returns AI-synthesized answers with citations from real-time web search."
        : provider === "grok"
            ? "Search the web using xAI Grok. Returns AI-synthesized answers with citations from real-time web search."
            : provider === "duckduckgo"
                ? "Search the web using DuckDuckGo Instant Answer API. Returns web results with titles, URLs, and snippets. No API key required."
                : provider === "kimi"
                    ? "Search the web using Kimi by Moonshot. Returns AI-synthesized answers with citations from native $web_search."
                    : provider === "gemini"
                        ? "Search the web using Gemini with Google Search grounding. Returns AI-synthesized answers with citations from Google Search."
                        : "Search the web using Brave Search API. Supports region-specific and localized search via country and language parameters. Returns titles, URLs, and snippets for fast research.";
    return {
        label: "Web Search",
        name: "web_search",
        description,
        parameters: WebSearchSchema,
        execute: async (_toolCallId, args) => {
            const perplexityAuth = provider === "perplexity" ? resolvePerplexityApiKey(perplexityConfig) : undefined;
            const apiKey = provider === "perplexity"
                ? perplexityAuth?.apiKey
                : provider === "grok"
                    ? resolveGrokApiKey(grokConfig)
                    : provider === "kimi"
                        ? resolveKimiApiKey(kimiConfig)
                        : provider === "gemini"
                            ? resolveGeminiApiKey(geminiConfig)
                            : resolveSearchApiKey(search);
            if (!apiKey) {
                return jsonResult(missingSearchKeyPayload(provider));
            }
            const params = args;
            const query = readStringParam(params, "query", { required: true });
            const count = readNumberParam(params, "count", { integer: true }) ?? search?.maxResults ?? undefined;
            const country = readStringParam(params, "country");
            const rawSearchLang = readStringParam(params, "search_lang");
            const rawUiLang = readStringParam(params, "ui_lang");
            const normalizedBraveLanguageParams = provider === "brave"
                ? normalizeBraveLanguageParams({ search_lang: rawSearchLang, ui_lang: rawUiLang })
                : { search_lang: rawSearchLang, ui_lang: rawUiLang };
            if (normalizedBraveLanguageParams.invalidField === "search_lang") {
                return jsonResult({
                    error: "invalid_search_lang",
                    message: "search_lang must be a 2-letter ISO language code like 'en' (not a locale like 'en-US').",
                    docs: "https://docs.openclaw.ai/tools/web",
                });
            }
            if (normalizedBraveLanguageParams.invalidField === "ui_lang") {
                return jsonResult({
                    error: "invalid_ui_lang",
                    message: "ui_lang must be a language-region locale like 'en-US'.",
                    docs: "https://docs.openclaw.ai/tools/web",
                });
            }
            const search_lang = normalizedBraveLanguageParams.search_lang;
            const ui_lang = normalizedBraveLanguageParams.ui_lang;
            const rawFreshness = readStringParam(params, "freshness");
            if (rawFreshness && provider !== "brave" && provider !== "perplexity") {
                return jsonResult({
                    error: "unsupported_freshness",
                    message: "freshness is only supported by the Brave and Perplexity web_search providers.",
                    docs: "https://docs.openclaw.ai/tools/web",
                });
            }
            const freshness = rawFreshness ? normalizeFreshness(rawFreshness) : undefined;
            if (rawFreshness && !freshness) {
                return jsonResult({
                    error: "invalid_freshness",
                    message: "freshness must be one of pd, pw, pm, py, or a range like YYYY-MM-DDtoYYYY-MM-DD.",
                    docs: "https://docs.openclaw.ai/tools/web",
                });
            }
            const result = await runWebSearch({
                query,
                count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
                apiKey,
                timeoutSeconds: resolveTimeoutSeconds(search?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS),
                cacheTtlMs: resolveCacheTtlMs(search?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES),
                provider,
                country,
                search_lang,
                ui_lang,
                freshness,
                perplexityBaseUrl: resolvePerplexityBaseUrl(perplexityConfig, perplexityAuth?.source, perplexityAuth?.apiKey),
                perplexityModel: resolvePerplexityModel(perplexityConfig),
                grokModel: resolveGrokModel(grokConfig),
                grokInlineCitations: resolveGrokInlineCitations(grokConfig),
                geminiModel: resolveGeminiModel(geminiConfig),
                kimiBaseUrl: resolveKimiBaseUrl(kimiConfig),
                kimiModel: resolveKimiModel(kimiConfig),
            });
            return jsonResult(result);
        },
    };
}
export const __testing = {
    resolveSearchProvider,
    inferPerplexityBaseUrlFromApiKey,
    resolvePerplexityBaseUrl,
    isDirectPerplexityBaseUrl,
    resolvePerplexityRequestModel,
    normalizeBraveLanguageParams,
    normalizeFreshness,
    freshnessToPerplexityRecency,
    resolveGrokApiKey,
    resolveGrokModel,
    resolveGrokInlineCitations,
    extractGrokContent,
    resolveKimiApiKey,
    resolveKimiModel,
    resolveKimiBaseUrl,
    extractKimiCitations,
    resolveRedirectUrl: resolveCitationRedirectUrl,
};
