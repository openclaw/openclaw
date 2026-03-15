import type { ReviewArtifact, ReviewFinding, ReviewAnalyzerName } from "./types.js";

type ReviewRule = {
  id: string;
  analyzer: ReviewAnalyzerName;
  appliesTo: ReviewArtifact["kind"][];
  evaluate: (artifact: ReviewArtifact) => ReviewFinding[];
};

function makeFinding(params: {
  finding: string;
  severity: ReviewFinding["severity"];
  affectedArea: string;
  preconditions: string[];
  whyItMatters: string;
  evidence: string[];
  recommendedFix: string[];
  regressionTestIdea: string;
}): ReviewFinding {
  return {
    finding: params.finding,
    severity: params.severity,
    affected_area: params.affectedArea,
    preconditions: params.preconditions,
    why_it_matters: params.whyItMatters,
    evidence: params.evidence,
    recommended_fix: params.recommendedFix,
    regression_test_idea: params.regressionTestIdea,
  };
}

function getRoutePath(artifact: ReviewArtifact): string {
  const routePath = artifact.metadata?.routePath;
  return typeof routePath === "string" ? routePath : artifact.name;
}

function getMethod(artifact: ReviewArtifact): string {
  const method = artifact.metadata?.method;
  return typeof method === "string" ? method.toUpperCase() : "GET";
}

function hasPattern(content: string, pattern: RegExp): boolean {
  return pattern.test(content);
}

function combineArtifactText(artifact: ReviewArtifact): string {
  return `${artifact.name}\n${getRoutePath(artifact)}\n${artifact.content}\n${JSON.stringify(artifact.metadata ?? {})}`;
}

function isAuthEndpoint(artifact: ReviewArtifact): boolean {
  return /\/auth\/(login|register|send-otp|verify-otp|reset-password|verify-email)\b/i.test(
    getRoutePath(artifact),
  );
}

function isOtpArtifact(artifact: ReviewArtifact): boolean {
  return /otp|verify-phone|verify_phone|send-otp|verify-otp/i.test(combineArtifactText(artifact));
}

function isWebhookArtifact(artifact: ReviewArtifact): boolean {
  return /webhook/i.test(combineArtifactText(artifact));
}

function isAdminArtifact(artifact: ReviewArtifact): boolean {
  return /\/admin\b|requireAdmin|isAdmin|admin-only|admin only/i.test(
    combineArtifactText(artifact),
  );
}

function looksLikeResourceRoute(artifact: ReviewArtifact): boolean {
  const routePath = getRoutePath(artifact);
  return /\[[^/]+\]|:[^/]+/.test(routePath) || /\bparams\.[a-zA-Z0-9_]*id\b/.test(artifact.content);
}

function hasAuthGuard(content: string): boolean {
  return /requireAuth|getActorUserId|supabase\.auth\.getUser|currentUser|session\.user|requireUser|auth\(|ensureSession/i.test(
    content,
  );
}

function hasAdminGuard(content: string): boolean {
  return /requireAdmin|isAdmin|assertAdmin|adminGuard/i.test(content);
}

function hasOwnershipSignals(content: string): boolean {
  return /owner|actor|getActorUserId|user_id|created_by|participant|membership|author_id|account_id|profile_id/i.test(
    content,
  );
}

function hasRateLimitSignals(content: string): boolean {
  return /rateLimit|rate_limit|limiter|throttle|retryAfter|too many requests|attemptCount|attempt_count/i.test(
    content,
  );
}

function hasValidationSignals(content: string): boolean {
  return /z\.object|safeParse|schema\.parse|schema\.safeParse|validate\(|validator|parseRequest/i.test(
    content,
  );
}

function hasOtpReplaySignals(content: string): boolean {
  return /used_at|usedAt|consum|invalidate|mark.*used|single.?use|expires_at|expiresAt|attempt_count|attemptCount|delete/i.test(
    content,
  );
}

function hasWebhookVerificationSignals(content: string): boolean {
  return /signature|constructEvent|verify.*signature|webhook.*secret|hmac|svix|rawBody/i.test(
    content,
  );
}

function findMatch(content: string, pattern: RegExp): string {
  const match = content.match(pattern);
  return match?.[0] ?? pattern.toString();
}

export const REVIEW_RULES: ReviewRule[] = [
  {
    id: "privileged-supabase-usage",
    analyzer: "auth-bypass",
    appliesTo: ["code-snippet", "route"],
    evaluate: (artifact) => {
      const pattern = /service_role|SUPABASE_SERVICE_ROLE|createServerClient|supabaseAdmin/iu;
      if (!hasPattern(artifact.content, pattern)) {
        return [];
      }
      return [
        makeFinding({
          finding: "Privileged Supabase or service-role usage detected",
          severity: "high",
          affectedArea: artifact.name,
          preconditions: [
            "The supplied artifact is reachable from a user-facing or shared server path.",
          ],
          whyItMatters:
            "Privileged clients can bypass actor scoping and turn a small route mistake into broad data exposure.",
          evidence: [`Matched pattern: ${findMatch(artifact.content, pattern)}`],
          recommendedFix: [
            "Move privileged access behind explicit admin-only or internal-only boundaries.",
            "Use the least-privilege client for user-facing flows.",
          ],
          regressionTestIdea:
            "Add a route-level test proving a normal user flow cannot read or mutate another actor's records through the privileged code path.",
        }),
      ];
    },
  },
  {
    id: "raw-error-message",
    analyzer: "data-exposure",
    appliesTo: ["code-snippet", "route"],
    evaluate: (artifact) => {
      const pattern = /error\.message/iu;
      if (!hasPattern(artifact.content, pattern)) {
        return [];
      }
      return [
        makeFinding({
          finding: "Raw error.message exposure detected",
          severity: "medium",
          affectedArea: artifact.name,
          preconditions: [
            "An upstream dependency or thrown error returns sensitive internal details.",
          ],
          whyItMatters:
            "Raw exception text can leak provider details, stack hints, or hidden implementation context that helps attackers enumerate the system.",
          evidence: [`Matched pattern: ${findMatch(artifact.content, pattern)}`],
          recommendedFix: [
            "Replace raw exception output with a stable, product-safe public error string.",
            "Keep detailed internals only in protected logs or audit surfaces.",
          ],
          regressionTestIdea:
            "Force the dependency to throw and assert that the public response returns a fixed safe string instead of the raw exception.",
        }),
      ];
    },
  },
  {
    id: "unsafe-html-rendering",
    analyzer: "xss-rendering",
    appliesTo: ["code-snippet", "route"],
    evaluate: (artifact) => {
      const pattern = /dangerouslySetInnerHTML|innerHTML\s*=/iu;
      if (!hasPattern(artifact.content, pattern)) {
        return [];
      }
      return [
        makeFinding({
          finding: "Unsafe HTML rendering primitive detected",
          severity: "high",
          affectedArea: artifact.name,
          preconditions: ["Attacker-controlled content can reach the render path."],
          whyItMatters:
            "Unsafe HTML rendering can expose owners, craftsmen, or admins to stored or reflected XSS through profiles, messages, reviews, or job descriptions.",
          evidence: [`Matched pattern: ${findMatch(artifact.content, pattern)}`],
          recommendedFix: [
            "Prefer escaped rendering paths.",
            "If rich content is unavoidable, sanitize to a strict allowlist before rendering.",
          ],
          regressionTestIdea:
            "Render attacker-controlled HTML and assert that script-like payloads stay inert and escaped.",
        }),
      ];
    },
  },
  {
    id: "permissive-rls-policy",
    analyzer: "rls-alignment",
    appliesTo: ["sql-policy"],
    evaluate: (artifact) => {
      const pattern = /using\s*\(\s*true\s*\)|with\s+check\s*\(\s*true\s*\)/iu;
      if (!hasPattern(artifact.content, pattern)) {
        return [];
      }
      return [
        makeFinding({
          finding: "Overly broad SQL / RLS policy detected",
          severity: "critical",
          affectedArea: artifact.name,
          preconditions: ["The policy is active for a table holding user- or job-scoped data."],
          whyItMatters:
            "A policy that collapses to TRUE can silently defeat ownership boundaries and turn the database into an allow-all layer.",
          evidence: [`Matched pattern: ${findMatch(artifact.content, pattern)}`],
          recommendedFix: [
            "Replace permissive clauses with actor- and ownership-aware predicates.",
            "Align API expectations with policy checks for both read and write paths.",
          ],
          regressionTestIdea:
            "Add a second-actor test proving cross-user reads and writes are denied by the database itself, not only by API logic.",
        }),
      ];
    },
  },
  {
    id: "missing-auth-guard",
    analyzer: "auth-bypass",
    appliesTo: ["route"],
    evaluate: (artifact) => {
      const content = artifact.content;
      const routePath = getRoutePath(artifact);
      const method = getMethod(artifact);
      if (isAuthEndpoint(artifact) || method === "GET" || hasAuthGuard(content)) {
        return [];
      }
      return [
        makeFinding({
          finding: "Route appears to mutate or expose scoped data without an obvious auth boundary",
          severity: "high",
          affectedArea: `${method} ${routePath}`,
          preconditions: [
            "The route is reachable by a caller that is not already constrained by a stronger upstream boundary.",
          ],
          whyItMatters:
            "Routes that operate on scoped data without a visible session or actor check can open direct auth-bypass or cross-account access paths.",
          evidence: [
            `HTTP method analyzed: ${method}`,
            "No obvious auth/session guard marker detected in the supplied handler source.",
          ],
          recommendedFix: [
            "Derive actor identity from trusted session context before business logic executes.",
            "Reject unauthenticated requests before accessing scoped resources.",
          ],
          regressionTestIdea:
            "Call the route without a session and assert it fails before any data access occurs.",
        }),
      ];
    },
  },
  {
    id: "actor-identity-from-request",
    analyzer: "authorization-idor",
    appliesTo: ["route"],
    evaluate: (artifact) => {
      const pattern =
        /(?:body|payload|query|searchParams|params|requestData|json\s*\().{0,120}\b(userId|ownerId|actorId|accountId|profileId)\b/isu;
      if (!hasPattern(artifact.content, pattern)) {
        return [];
      }
      return [
        makeFinding({
          finding: "Route appears to trust actor identity from request-controlled input",
          severity: "high",
          affectedArea: `${getMethod(artifact)} ${getRoutePath(artifact)}`,
          preconditions: ["The caller can supply or influence the referenced identity field."],
          whyItMatters:
            "Trusting actor identifiers from body, params, or query values creates a direct IDOR path unless the route re-binds identity to the authenticated actor.",
          evidence: [`Matched pattern: ${findMatch(artifact.content, pattern)}`],
          recommendedFix: [
            "Ignore caller-supplied actor IDs for authorization decisions.",
            "Bind identity and ownership checks to trusted session context and server-side lookups.",
          ],
          regressionTestIdea:
            "Attempt the same action using a second user's identifier and assert the route denies it.",
        }),
      ];
    },
  },
  {
    id: "missing-admin-guard",
    analyzer: "admin-boundary",
    appliesTo: ["route"],
    evaluate: (artifact) => {
      if (!isAdminArtifact(artifact) || hasAdminGuard(artifact.content)) {
        return [];
      }
      return [
        makeFinding({
          finding: "Admin or support route lacks an obvious admin boundary check",
          severity: "high",
          affectedArea: `${getMethod(artifact)} ${getRoutePath(artifact)}`,
          preconditions: [
            "The route is reachable from a user-accessible or shared server surface.",
          ],
          whyItMatters:
            "Support and admin routes without a clear privilege guard can collapse into privilege escalation or unrestricted internal reads.",
          evidence: [
            `Admin-sensitive path or marker detected in ${getRoutePath(artifact)}`,
            "No obvious requireAdmin/isAdmin-style guard marker detected.",
          ],
          recommendedFix: [
            "Enforce an explicit admin-only guard before any privileged query or mutation.",
            "Audit logging should attribute who triggered the admin action.",
          ],
          regressionTestIdea:
            "Call the route with a non-admin session and assert it fails before querying privileged data.",
        }),
      ];
    },
  },
  {
    id: "resource-route-without-ownership-signal",
    analyzer: "authorization-idor",
    appliesTo: ["route"],
    evaluate: (artifact) => {
      if (!looksLikeResourceRoute(artifact) || hasOwnershipSignals(artifact.content)) {
        return [];
      }
      return [
        makeFinding({
          finding: "Resource-scoped route lacks an obvious ownership or participant check",
          severity: "medium",
          affectedArea: `${getMethod(artifact)} ${getRoutePath(artifact)}`,
          preconditions: ["The route operates on a resource identified by id or route params."],
          whyItMatters:
            "Routes keyed by resource identifiers need a clear ownership, membership, or participant check or they can drift into IDOR behavior.",
          evidence: [
            `Resource-style route detected: ${getRoutePath(artifact)}`,
            "No obvious owner/actor/participant enforcement signal detected in the supplied handler.",
          ],
          recommendedFix: [
            "Require a server-side ownership or participant lookup before returning or mutating the resource.",
            "Document the exact ownership contract between the route and the database policy.",
          ],
          regressionTestIdea:
            "Use a second actor against the same route and assert the request is denied for another actor's resource.",
        }),
      ];
    },
  },
  {
    id: "otp-rate-limit-gap",
    analyzer: "otp-abuse",
    appliesTo: ["route", "flow"],
    evaluate: (artifact) => {
      if (!isOtpArtifact(artifact) || hasRateLimitSignals(artifact.content)) {
        return [];
      }
      return [
        makeFinding({
          finding: "OTP-related flow lacks an obvious rate limiting or attempt control signal",
          severity: "medium",
          affectedArea: artifact.name,
          preconditions: ["The flow or route can issue or verify OTPs repeatedly."],
          whyItMatters:
            "OTP endpoints without visible rate limits or attempt controls are vulnerable to brute force, enumeration, or delivery abuse.",
          evidence: [
            "OTP markers detected without obvious rate limiting or attempt control language.",
          ],
          recommendedFix: [
            "Add per-identity and per-IP rate limiting around OTP issuance and verification.",
            "Record and enforce attempt counters with clear cooldown behavior.",
          ],
          regressionTestIdea:
            "Repeatedly hit the OTP endpoint in tests and assert the limiter blocks or degrades repeated attempts predictably.",
        }),
      ];
    },
  },
  {
    id: "otp-replay-gap",
    analyzer: "otp-abuse",
    appliesTo: ["route", "flow"],
    evaluate: (artifact) => {
      if (!isOtpArtifact(artifact) || hasOtpReplaySignals(artifact.content)) {
        return [];
      }
      return [
        makeFinding({
          finding: "OTP-related flow lacks an obvious replay or one-time-use control",
          severity: "high",
          affectedArea: artifact.name,
          preconditions: ["An attacker can reuse or race OTP verification attempts."],
          whyItMatters:
            "OTP verification needs visible consumption, expiry, and replay invalidation semantics or codes may stay reusable longer than intended.",
          evidence: ["OTP markers detected without obvious consume/invalidate/expiry signals."],
          recommendedFix: [
            "Invalidate OTP material immediately after successful verification or expiry.",
            "Track one-time-use state and reject replay attempts deterministically.",
          ],
          regressionTestIdea:
            "Verify the same OTP twice and assert the second attempt fails as replay.",
        }),
      ];
    },
  },
  {
    id: "webhook-signature-gap",
    analyzer: "webhook-verification",
    appliesTo: ["route", "flow"],
    evaluate: (artifact) => {
      if (!isWebhookArtifact(artifact) || hasWebhookVerificationSignals(artifact.content)) {
        return [];
      }
      return [
        makeFinding({
          finding:
            "Webhook processing lacks an obvious signature or authenticity verification step",
          severity: "high",
          affectedArea: artifact.name,
          preconditions: ["The route or flow accepts requests from an external provider."],
          whyItMatters:
            "Webhook handlers that process unverified requests can be spoofed, replayed, or fed tampered payloads.",
          evidence: ["Webhook markers detected without obvious signature verification language."],
          recommendedFix: [
            "Verify provider signatures before parsing or acting on the payload.",
            "Enforce replay windows and idempotency for repeated deliveries.",
          ],
          regressionTestIdea:
            "Send a webhook request with an invalid signature and assert it is rejected before business logic executes.",
        }),
      ];
    },
  },
  {
    id: "sensitive-logging",
    analyzer: "data-exposure",
    appliesTo: ["code-snippet", "route"],
    evaluate: (artifact) => {
      const pattern =
        /(?:console\.(?:log|error|warn)|logger\.(?:info|warn|error)|debug\().{0,160}\b(token|otp|secret|authorization|cookie|email|phone)\b/isu;
      if (!hasPattern(artifact.content, pattern)) {
        return [];
      }
      return [
        makeFinding({
          finding: "Potential sensitive data logging detected",
          severity: "high",
          affectedArea: artifact.name,
          preconditions: [
            "Logs are accessible by operators, lower-trust tooling, or external log sinks.",
          ],
          whyItMatters:
            "Logging tokens, OTPs, cookies, phone numbers, or email identifiers creates an avoidable data exposure path even when the main route is correct.",
          evidence: [`Matched pattern: ${findMatch(artifact.content, pattern)}`],
          recommendedFix: [
            "Remove or redact sensitive fields before logging.",
            "Prefer structured audit logs with explicit allowlisted fields.",
          ],
          regressionTestIdea:
            "Capture logs during the route execution and assert that sensitive fields are absent or redacted.",
        }),
      ];
    },
  },
  {
    id: "missing-input-validation",
    analyzer: "input-validation",
    appliesTo: ["route"],
    evaluate: (artifact) => {
      const bodyReadPattern = /(?:await\s+\w+\.json\s*\(|request\.json\s*\(|ctx\.req\.json\s*\()/iu;
      if (
        !hasPattern(artifact.content, bodyReadPattern) ||
        hasValidationSignals(artifact.content)
      ) {
        return [];
      }
      return [
        makeFinding({
          finding: "Request body parsing lacks an obvious schema validation step",
          severity: "medium",
          affectedArea: `${getMethod(artifact)} ${getRoutePath(artifact)}`,
          preconditions: ["The caller can send arbitrary payload shapes or field types."],
          whyItMatters:
            "Routes that parse JSON without a visible schema boundary are more likely to accept malformed, over-broad, or surprising inputs that affect auth or data integrity.",
          evidence: [
            `Matched body-read pattern: ${findMatch(artifact.content, bodyReadPattern)}`,
            "No obvious zod/schema/validator signal detected nearby.",
          ],
          recommendedFix: [
            "Validate the parsed body against an explicit schema before business logic runs.",
            "Reject unknown or malformed fields with stable public errors.",
          ],
          regressionTestIdea:
            "Submit malformed or extra fields and assert the route rejects them before any downstream mutation occurs.",
        }),
      ];
    },
  },
];
