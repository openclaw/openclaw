import { AWS_SECRET_ACCESS_KEY_MATCHER, FORM_BODY_KEY_INVISIBLE_CHARS } from "./redact-patterns.js";

// Fast-path gate: with no user-configured patterns, redactSensitiveText skips the full
// default-pattern walk unless one of these triggers matches. Every DEFAULT_REDACT_PATTERNS
// entry and sensitive form/URL key must stay reachable here — a missing trigger silently
// leaks that secret shape, so each family keeps a default-options fixture in redact.test.ts.
// Keep word-only admission: the shared compiler can expose mutated built-in regexes.
const FIELD_KEY_PREFILTER_RE =
  /KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|COOKIE|SIGNATURE|CREDENTIAL|CARD|CVC|CVV|PAYMENT|security[-_]?code|\bpass\s*[=:]|\bpassphrase\s*[=:]|_(?:password|pass|passphrase|passwd)\s*[=:]|jwt\s*[=:]|session=|code=|\bsig\s*=/iu;
const SEPARATED_VENDOR_PREFILTER_RE =
  /sk-|gh[opsur]_|github_pat_|glpat-|gloas-|gldt-|glcbt-|glptt-|glft-|glimt-|glagent-|glwt-|glsoat-|glffct-|glrt-|glrtr-|_gitlab_session=|xox[baprs]-|xapp-|gsk_|pplx-|fal_|fc-|bb_live_|[sr]k_(?:live|test)_|npm_|pypi-|do[opr]_v1_|dckr_|bkua_|CCIPAT_|sbp_|dd[pw]_|glsa_|nfp_|CFPAT-|BBDC-|HRKU-|pat-(?:eu|na)1-|apify_api_|fio-u-|tvly-|exa_|syt_|retaindb_|mem0_|brv_|xai-|fw-|fw_|fpk_|(?:^|[^A-Za-z0-9_])(?:am_|sk_)|hf_|api_org_|r8_/iu;
const DEFAULT_REDACT_PREFILTER_RE =
  /PRIVATE KEY|\bBearer\s+|GR1348941|hooks\.slack\.com|discord|AIza|ya29\.|1\/\/0|eyJ|gAAAA|SG\.|dp\.(?:ct|pt|sa|st|scim|audit)\.|dapi[0-9a-f]|ATCTT3|ATATT|ATBB|FlyV1|A[KS]IA[A-Z0-9]|AKID|LTAI|\bbot\d{6,}:|\b\d{6,}:[A-Za-z0-9_-]{20,}/iu;
// Broad, linear presence probes deliberately over-trigger. A length cap here would silently
// bypass the actual URL and normalized-key matchers on long but valid credentials. In particular,
// regex lookbehinds across arbitrary userinfo or invisible key padding stall JSC on large inputs.
const OBFUSCATED_KEY_CHAR_RE = new RegExp(`[${FORM_BODY_KEY_INVISIBLE_CHARS}+%]`, "u");

// Whole-context rules admit prefixes whose boundaries differ under Unicode case folding.
// Keep the shared text probe unchanged: its chunked matching has separate boundary semantics.
const FULL_CONTEXT_REDACT_EXTRA_TRIGGERS_RE =
  /JWT|Bearer\s+|am_|sk_|(?<!\d)\d{6,}:[A-Za-z0-9_-]{20,}/i;

export function couldMatchDefaultRedactPatterns(text: string): boolean {
  return (
    FIELD_KEY_PREFILTER_RE.test(text) ||
    ((text.includes("-") || text.includes("_")) && SEPARATED_VENDOR_PREFILTER_RE.test(text)) ||
    DEFAULT_REDACT_PREFILTER_RE.test(text) ||
    (text.includes("://") && text.includes("@")) ||
    (text.includes("=") && OBFUSCATED_KEY_CHAR_RE.test(text)) ||
    AWS_SECRET_ACCESS_KEY_MATCHER.couldMatch(text)
  );
}

export function couldMatchDefaultFullContextPatterns(text: string): boolean {
  return couldMatchDefaultRedactPatterns(text) || FULL_CONTEXT_REDACT_EXTRA_TRIGGERS_RE.test(text);
}

export function couldMatchVendorRedactPatterns(text: string): boolean {
  return (
    ((text.includes("-") || text.includes("_")) && SEPARATED_VENDOR_PREFILTER_RE.test(text)) ||
    DEFAULT_REDACT_PREFILTER_RE.test(text) ||
    FULL_CONTEXT_REDACT_EXTRA_TRIGGERS_RE.test(text)
  );
}

export function createRedactPrefilter(probe: (text: string) => boolean): (text: string) => boolean {
  // Owned by one synchronous traversal; only its exact post-registry inputs are retained.
  // The built-in probe policy is immutable. Custom patterns and field masking never use this cache.
  const matches = new Map<string, boolean>();
  return (text) => {
    const cached = matches.get(text);
    if (cached !== undefined) {
      return cached;
    }
    const result = probe(text);
    matches.set(text, result);
    return result;
  };
}
