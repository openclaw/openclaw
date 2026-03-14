/**
 * Privacy replacer — generates realistic-looking fake replacements for detected sensitive content.
 * Replacements preserve format so LLM can still understand the semantic context.
 *
 * Same original text within a session maps to the same replacement (idempotent).
 */

import type { DetectionMatch, PrivacyMapping } from "./types.js";

/** Replacement generator that maintains a session-scoped mapping cache. */
export class PrivacyReplacer {
  private sessionId: string;
  /** original → replacement */
  private forwardMap = new Map<string, string>();
  /** replacement → original */
  private reverseMap = new Map<string, string>();
  /** Full mapping records for persistence. */
  private mappings: PrivacyMapping[] = [];
  private seq = 0;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * Replace all detected matches in text with fake values.
   * Returns the replaced text and the list of new mappings created.
   */
  replaceAll(
    text: string,
    matches: DetectionMatch[],
  ): { replaced: string; newMappings: PrivacyMapping[] } {
    if (matches.length === 0) {
      return { replaced: text, newMappings: [] };
    }

    const newMappings: PrivacyMapping[] = [];
    // Select non-overlapping matches in source order first so a later-start
    // submatch cannot suppress an earlier full-span secret match.
    const selected = selectNonOverlappingMatches(matches);
    // Process replacements from end to start to preserve indices.
    const sorted = [...selected].toSorted((a, b) => b.start - a.start);

    let result = text;
    let processedStart = Infinity;
    for (const match of sorted) {
      // Skip if this match overlaps with an already-processed (later) region.
      if (match.end > processedStart) {
        continue;
      }

      const replacement = this.getOrCreateReplacement(match);

      // Skip identity replacements (e.g. confidential markers that don't need substitution).
      if (replacement.mapping.replacement === match.content) {
        continue;
      }

      if (replacement.isNew) {
        newMappings.push(replacement.mapping);
      }
      result =
        result.slice(0, match.start) + replacement.mapping.replacement + result.slice(match.end);
      processedStart = match.start;
    }

    return { replaced: result, newMappings };
  }

  /**
   * Reverse-replace: scan text for any known replacement strings and restore originals.
   */
  restore(text: string): string {
    if (this.reverseMap.size === 0) {
      return text;
    }

    let result = text;
    // Sort replacements by length descending to avoid partial matches.
    const entries = [...this.reverseMap.entries()].toSorted((a, b) => b[0].length - a[0].length);
    for (const [replacement, original] of entries) {
      // Use split+join for reliable replacement (no regex special chars issue).
      result = result.split(replacement).join(original);
    }
    return result;
  }

  /** Get all current mappings. */
  getMappings(): PrivacyMapping[] {
    return [...this.mappings];
  }

  /** Load previously persisted mappings (e.g. from encrypted store). */
  loadMappings(mappings: PrivacyMapping[]): void {
    for (const m of mappings) {
      if (!this.forwardMap.has(m.original)) {
        this.forwardMap.set(m.original, m.replacement);
        this.reverseMap.set(m.replacement, m.original);
        this.mappings.push(m);
      }
    }
  }

  /** Clear all mappings. */
  clear(): void {
    this.forwardMap.clear();
    this.reverseMap.clear();
    this.mappings = [];
    this.seq = 0;
  }

  private getOrCreateReplacement(match: DetectionMatch): {
    mapping: PrivacyMapping;
    isNew: boolean;
  } {
    const existing = this.forwardMap.get(match.content);
    if (existing) {
      const mapping = this.mappings.find((m) => m.original === match.content);
      return { mapping: mapping!, isNew: false };
    }

    const now = Date.now();
    const seqId = this.seq++;
    const replacement = generateReplacement(
      match.type,
      match.content,
      now,
      seqId,
      match.replacementTemplate,
    );
    const id = `pf_${now}_${seqId}`;

    const mapping: PrivacyMapping = {
      id,
      sessionId: this.sessionId,
      original: match.content,
      replacement,
      type: match.type,
      riskLevel: match.riskLevel,
      createdAt: now,
    };

    this.forwardMap.set(match.content, replacement);
    this.reverseMap.set(replacement, match.content);
    this.mappings.push(mapping);

    return { mapping, isNew: true };
  }
}

function selectNonOverlappingMatches(matches: DetectionMatch[]): DetectionMatch[] {
  const sorted = [...matches].toSorted((a, b) => {
    if (a.start !== b.start) {
      return a.start - b.start;
    }
    const spanDiff = b.end - b.start - (a.end - a.start);
    if (spanDiff !== 0) {
      return spanDiff;
    }
    return riskRank(b.riskLevel) - riskRank(a.riskLevel);
  });

  const selected: DetectionMatch[] = [];
  let lastEnd = -1;
  for (const match of sorted) {
    if (match.start < lastEnd) {
      continue;
    }
    selected.push(match);
    lastEnd = match.end;
  }
  return selected;
}

function riskRank(level: DetectionMatch["riskLevel"]): number {
  switch (level) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

/**
 * Generate a type-appropriate fake replacement value.
 * Preserves format so the LLM understands the semantic context.
 */
function generateReplacement(
  type: string,
  original: string,
  timestamp: number,
  seq: number,
  replacementTemplate?: string,
): string {
  const ts = String(timestamp).slice(-10);
  const suffix = `${ts}${seq}`;

  // If a custom replacement template is provided, use it.
  if (replacementTemplate) {
    return applyReplacementTemplate(replacementTemplate, { type, original, seq, ts });
  }

  switch (type) {
    case "email":
      return `pf_e${suffix}@example.net`;

    case "phone_cn":
      return `139${suffix.slice(0, 8).padEnd(8, "0")}`;

    case "phone_hk":
    case "phone_tw":
    case "phone_us":
      return `pf_ph_${suffix.slice(0, 8)}`;

    case "id_card_cn":
      // Keep format: 6 region + 8 date + 3 seq + 1 check
      return `110101199001${suffix.slice(0, 4).padEnd(4, "0")}9X`;

    case "credit_card":
    case "credit_card_visa":
    case "credit_card_mastercard":
    case "credit_card_amex":
    case "credit_card_discover":
    case "credit_card_unionpay":
      return `4000${suffix.slice(0, 12).padEnd(12, "0")}`;

    case "password_assignment":
    case "env_password": {
      // Keep the key=value structure, replace only the value part.
      const eqIdx = original.search(/[:=]/);
      if (eqIdx >= 0) {
        const prefix = original.slice(0, eqIdx + 1);
        return `${prefix}PF_PWD_${suffix}`;
      }
      return `PF_PWD_${suffix}`;
    }

    case "openai_api_key":
      return `sk-pf${suffix}${"x".repeat(Math.max(0, original.length - 4 - suffix.length))}`;

    case "anthropic_api_key":
      return `sk-ant-pf${suffix}${"x".repeat(Math.max(0, 20))}`;

    case "github_token": {
      const prefixMatch = original.match(/^(ghp|gho|ghu|ghs|ghr)_/);
      const pfx = prefixMatch ? prefixMatch[1] : "ghp";
      return `${pfx}_pf${suffix}${"x".repeat(Math.max(0, 36 - suffix.length))}`;
    }

    case "aws_access_key":
      return `AKIAPF${suffix.slice(0, 16).padEnd(16, "X")}`;

    case "jwt_token":
      // Generate a fake but format-correct JWT-like string.
      return `eyJwZiI6InRydWUifQ.eyJwZl90cyI6IiR7${ts}In0.pf_sig_${suffix}`;

    case "bearer_token": {
      const bearerMatch = original.match(/^(bearer\s+)/i);
      const bearerPfx = bearerMatch ? bearerMatch[1] : "Bearer ";
      return `${bearerPfx}pf_token_${suffix}${"x".repeat(20)}`;
    }

    case "basic_auth":
      return `Authorization: Basic cGZfdXNlcjpwZl9wYXNz${suffix}`;

    case "ssh_private_key":
    case "pgp_private_key":
    case "pkcs8_private_key":
      return `-----BEGIN PF PRIVATE KEY-----\npf_redacted_${suffix}\n-----END PF PRIVATE KEY-----`;

    case "database_url_mysql":
      return `mysql://pf_user:pf_pass_${suffix}@pf-host/pf_db`;

    case "database_url_postgresql":
      return `postgresql://pf_user:pf_pass_${suffix}@pf-host/pf_db`;

    case "database_url_mongodb":
      return `mongodb://pf_user:pf_pass_${suffix}@pf-host/pf_db`;

    case "redis_url":
      return `redis://:pf_pass_${suffix}@pf-host:6379/`;

    case "url_with_credentials":
      return `https://pf_user:pf_pass_${suffix}@pf-host.example.com/`;

    case "slack_token":
      return `xoxb-pftoken${suffix}-${"x".repeat(24)}`;

    case "google_api_key":
    case "firebase_key":
      return `AIzaPF${suffix}${"x".repeat(Math.max(0, 35 - suffix.length))}`;

    case "stripe_api_key": {
      const stripePfx = original.match(/^(sk|pk|rk)_(live|test)_/)?.[0] ?? "sk_test_";
      return `${stripePfx}pf${suffix}${"x".repeat(24)}`;
    }

    case "alibaba_access_key":
      return `LTAIpf${suffix.slice(0, 16)}`;

    case "tencent_secret_id":
      return `AKIDpf${suffix}${"x".repeat(Math.max(0, 32 - suffix.length))}`;

    case "social_security_number_us":
      return `000-${suffix.slice(0, 2).padEnd(2, "0")}-${suffix.slice(2, 6).padEnd(4, "0")}`;

    case "iban":
      return `XX00PFLT${suffix.slice(0, 12).padEnd(12, "0")}`;

    case "ipv4_private":
      return `10.0.${seq % 256}.${(seq + 1) % 256}`;

    case "ipv4_public":
      return `198.51.100.${seq % 256}`;

    case "salary_amount": {
      // Keep the label, replace the number.
      const salaryMatch = original.match(/(年薪|月薪|工资|薪水|salary|compensation)\s*[:：]?\s*/i);
      const label = salaryMatch ? salaryMatch[0] : "";
      return `${label}PF_AMOUNT_${suffix}`;
    }

    case "bare_password":
      // Replace with a fake password of similar length that preserves complexity appearance.
      return `PF_Pw${suffix}!x`;

    case "high_entropy_string":
      // Replace with a fake token of similar length.
      return `pf_ent_${suffix}${"x".repeat(Math.max(0, original.length - 7 - suffix.length))}`;

    default:
      // Generic replacement preserving approximate length.
      return `pf_${type}_${suffix}`;
  }
}

/** Apply a replacement template string with placeholder substitution. */
function applyReplacementTemplate(
  template: string,
  ctx: { type: string; original: string; seq: number; ts: string },
): string {
  return template
    .replace(/\{type\}/g, ctx.type)
    .replace(/\{seq\}/g, String(ctx.seq))
    .replace(/\{ts\}/g, ctx.ts)
    .replace(/\{original_prefix:(\d+)\}/g, (_, n) => ctx.original.slice(0, parseInt(n, 10)))
    .replace(/\{original_length\}/g, String(ctx.original.length))
    .replace(/\{pad:(\d+)\}/g, (_, n) => "x".repeat(Math.max(0, parseInt(n, 10))));
}
