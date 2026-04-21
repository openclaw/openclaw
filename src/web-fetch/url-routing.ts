/**
 * URL Routing for web_fetch
 *
 * Allows agents to configure domain-specific routing rules that fire
 * before web_fetch is called. When a URL matches a rule, the tool call
 * can be blocked with a redirect hint, warned, or allowed through.
 *
 * Configured via tools.web.fetch.urlRouting in openclaw.json.
 *
 * @example
 * ```json
 * {
 *   "tools": {
 *     "web": {
 *       "fetch": {
 *         "urlRouting": [
 *           {
 *             "match": "x\\.com|twitter\\.com",
 *             "action": "redirect",
 *             "redirectTo": "skill:xread",
 *             "reason": "X.com blocks unauthenticated fetch. Use the xread skill (Grok API) instead."
 *           },
 *           {
 *             "match": "linkedin\\.com",
 *             "action": "warn",
 *             "reason": "LinkedIn blocks scrapers — results may be empty or partial."
 *           }
 *         ]
 *       }
 *     }
 *   }
 * }
 * ```
 */

export type UrlRoutingAction = "redirect" | "warn" | "block";

export type UrlRoutingRule = {
  /**
   * Regex pattern matched against the full URL (case-insensitive).
   * Examples: "x\\.com|twitter\\.com", "linkedin\\.com", ".*\\.internal\\.corp"
   */
  match: string;
  /**
   * What to do when the pattern matches:
   * - "redirect": block the fetch and tell the agent to use redirectTo instead
   * - "warn": allow the fetch but prepend a warning message to the result
   * - "block": block the fetch with no redirect suggestion
   */
  action: UrlRoutingAction;
  /**
   * Human-readable reason shown to the agent explaining why routing applies.
   */
  reason?: string;
  /**
   * For action="redirect": where to route instead.
   * Use "skill:<slug>" for skills (e.g. "skill:xread"),
   * or "tool:<name>" for tools (e.g. "tool:web_search").
   */
  redirectTo?: string;
};

export type UrlRoutingConfig = UrlRoutingRule[];

/**
 * Result of evaluating URL routing rules against a URL.
 */
export type UrlRoutingResult =
  | { matched: false }
  | {
      matched: true;
      rule: UrlRoutingRule;
      /** Ready-to-use block reason string for PluginHookBeforeToolCallResult.blockReason */
      blockReason?: string;
      /** For action="warn": message to prepend to the tool result */
      warnMessage?: string;
    };

/**
 * Evaluate URL routing rules against a URL.
 * Returns the first matching rule result, or { matched: false }.
 */
export function evaluateUrlRouting(url: string, rules: UrlRoutingConfig): UrlRoutingResult {
  for (const rule of rules) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(rule.match, "i");
    } catch {
      // Invalid regex — skip silently (misconfiguration shouldn't crash the agent)
      continue;
    }

    if (!pattern.test(url)) {
      continue;
    }

    if (rule.action === "redirect") {
      const redirectHint = rule.redirectTo ? ` Use ${rule.redirectTo} instead.` : "";
      const reasonHint = rule.reason ? ` Reason: ${rule.reason}` : "";
      return {
        matched: true,
        rule,
        blockReason: `URL routing: "${url}" matches pattern "${rule.match}" — web_fetch blocked.${redirectHint}${reasonHint}`,
      };
    }

    if (rule.action === "block") {
      const reasonHint = rule.reason ? ` Reason: ${rule.reason}` : "";
      return {
        matched: true,
        rule,
        blockReason: `URL routing: "${url}" matches pattern "${rule.match}" — web_fetch blocked.${reasonHint}`,
      };
    }

    if (rule.action === "warn") {
      const reasonHint = rule.reason ?? `URL matches pattern "${rule.match}"`;
      return {
        matched: true,
        rule,
        warnMessage: `⚠️ URL routing warning: ${reasonHint}`,
      };
    }
  }

  return { matched: false };
}

/**
 * Extract URL routing config from the tools.web.fetch config object.
 * Returns an empty array if not configured.
 */
export function resolveUrlRoutingRules(
  fetchConfig: { urlRouting?: UrlRoutingConfig } | undefined,
): UrlRoutingConfig {
  return fetchConfig?.urlRouting ?? [];
}
