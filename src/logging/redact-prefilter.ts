import { AWS_SECRET_ACCESS_KEY_MATCHER, FORM_BODY_KEY_INVISIBLE_CHARS } from "./redact-patterns.js";

// Fast-path gate: with no user-configured patterns, redactSensitiveText skips the full
// default-pattern walk unless one of these triggers matches. Every DEFAULT_REDACT_PATTERNS
// entry and sensitive form/URL key must stay reachable here — a missing trigger silently
// leaks that secret shape, so each family keeps a default-options fixture in redact.test.ts.
const DEFAULT_REDACT_PREFILTER_SOURCES: string[] = [
  // Sensitive key names shared by the env/JSON/query/form/header/assignment families.
  String.raw`KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|COOKIE|SIGNATURE|CREDENTIAL|CARD|CVC|CVV|PAYMENT|PRIVATE KEY`,
  String.raw`security[-_]?code|\bpass\s*[=:]|\bpassphrase\s*[=:]|_(?:password|pass|passphrase|passwd)\s*[=:]|jwt\s*[=:]|session=|code=|\bsig\s*=`,
  String.raw`\bBearer\s+`,
  // URL userinfo and connection-string password slots (`scheme://user:pass@host`).
  String.raw`:\/\/[^\/\s:@]*:[^\s@]+@`,
  // Vendor token prefixes and webhook hosts, ordered like DEFAULT_REDACT_PATTERNS.
  String.raw`sk-|gh[opsur]_|github_pat_|glpat-|gloas-|gldt-|glcbt-|glptt-|glft-|glimt-|glagent-|glwt-|glsoat-|glffct-|glrt-|glrtr-|GR1348941|_gitlab_session=|xox[baprs]-|xapp-|hooks\.slack\.com|discord|gsk_|AIza|ya29\.|1\/\/0|eyJ|pplx-|fal_|fc-|bb_live_|gAAAA|[sr]k_(?:live|test)_|SG\.|npm_|pypi-|do[opr]_v1_|dp\.(?:ct|pt|sa|st|scim|audit)\.|dckr_|bkua_|CCIPAT_|sbp_|dapi[0-9a-f]|dd[pw]_|glsa_|nfp_|CFPAT-|ATCTT3|ATATT|ATBB|BBDC-|HRKU-|pat-(?:eu|na)1-|apify_api_|FlyV1|fio-u-|tvly-|exa_|syt_|retaindb_|mem0_|brv_|xai-|fw-|fw_|fpk_`,
  String.raw`(?:^|[^A-Za-z0-9_])(?:am_|sk_)`,
  String.raw`A[KS]IA[A-Z0-9]|AKID|LTAI|hf_|api_org_|r8_`,
  String.raw`\bbot\d{6,}:|\b\d{6,}:[A-Za-z0-9_-]{20,}`,
  // Obfuscated form/URL keys: percent escapes can rewrite any key letter, while plus or
  // invisible splices break the literal key-name triggers above mid-word. After a splice the
  // tail may mix further splices with key characters (e.g. an interior plus a trailing
  // filler). Require a key character before or after a splice so bare `+=` or line-leading
  // `===` separators do not trip the fast path.
  String.raw`%[0-9A-Fa-f]{2}[${FORM_BODY_KEY_INVISIBLE_CHARS}+A-Za-z0-9_%.-]*=`,
  // Search at the required assignment separator, not at every invisible character: the key run
  // right before `=` must hold a splice and a key character. Two flat lookbehinds keep that to
  // plain character-class scans. A repeated group inside the lookbehind made JSC abandon the whole
  // match (no error, no match) once the run before `=` passed roughly 70k characters, which
  // silently skipped default redaction for long texts on Bun.
  String.raw`=(?<=[${FORM_BODY_KEY_INVISIBLE_CHARS}+][${FORM_BODY_KEY_INVISIBLE_CHARS}+A-Za-z0-9_%.-]*=)(?<=[A-Za-z0-9_%.-][${FORM_BODY_KEY_INVISIBLE_CHARS}+A-Za-z0-9_%.-]*=)`,
];
const DEFAULT_REDACT_PREFILTER_RE = new RegExp(
  `(?:${DEFAULT_REDACT_PREFILTER_SOURCES.join("|")})`,
  "iu",
);

// Whole-context rules admit prefixes whose boundaries differ under Unicode case folding.
// Keep the shared text probe unchanged: its chunked matching has separate boundary semantics.
const FULL_CONTEXT_REDACT_EXTRA_TRIGGERS_RE =
  /JWT|Bearer\s+|am_|sk_|(?<!\d)\d{6,}:[A-Za-z0-9_-]{20,}/i;

export function couldMatchDefaultRedactPatterns(text: string): boolean {
  return DEFAULT_REDACT_PREFILTER_RE.test(text) || AWS_SECRET_ACCESS_KEY_MATCHER.couldMatch(text);
}

export function couldMatchDefaultFullContextPatterns(text: string): boolean {
  return couldMatchDefaultRedactPatterns(text) || FULL_CONTEXT_REDACT_EXTRA_TRIGGERS_RE.test(text);
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
