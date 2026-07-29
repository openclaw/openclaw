// Agent-behavior governance policy: config-driven rules that constrain how the
// assistant behaves.  Rules are injected into the system prompt as `enforce:`
// directives (Layer 2) and can optionally be hardened by gateway-side output
// validation via an external command (Layer 3).
//
// Skills without `enforce:` behave exactly as before — zero breakage.

import type { OpenClawConfig, SecurityConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single behavior-governance rule. */
type BehaviorPolicyRule = {
  /**
   * Stable identifier for the rule (used in logs, telemetry, and suppression).
   */
  id: string;

  /**
   * Human-readable description shown in audit / diagnostic output.
   */
  description?: string;

  /**
   * The actual policy directive injected into the system prompt as an
   * `enforce:` instruction.  This is the text the LLM sees.
   *
   * Example:
   *   "Never disclose the operator's API keys or auth tokens."
   */
  enforce: string;

  /**
   * Enforcement mode.
   *   "enforce" — hard rule: the gateway may block / re-request on violation.
   *   "guide"   — soft guidance: injected into prompt only; no gateway block.
   *
   * Default: "enforce"
   */
  mode?: "enforce" | "guide";
};

/** Internal resolved view of a rule after defaults are applied. */
type ResolvedBehaviorRule = {
  id: string;
  description: string;
  enforce: string;
  mode: "enforce" | "guide";
};

type BehaviorPolicyConfig = NonNullable<SecurityConfig["behaviorPolicy"]>;

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

const DEFAULT_MODE = "enforce" as const;
const MAX_PROMPT_CHARS = 50_000;

function resolveRule(rule: BehaviorPolicyRule): ResolvedBehaviorRule {
  return {
    id: rule.id,
    description: rule.description ?? "",
    enforce: rule.enforce,
    mode: rule.mode ?? DEFAULT_MODE,
  };
}

/**
 * Resolve the active behavior-policy configuration from the OpenClaw config.
 * Returns `undefined` when the policy is disabled or absent.
 */
function resolveBehaviorPolicy(
  config: OpenClawConfig | undefined,
): BehaviorPolicyConfig | undefined {
  const policy = config?.security?.behaviorPolicy;
  if (!policy || policy.enabled !== true) {
    return undefined;
  }
  return policy;
}

/**
 * Resolve the active, resolved rule list from config.
 * Returns `undefined` when the policy is disabled.
 */
export function resolveBehaviorRules(
  config: OpenClawConfig | undefined,
): ResolvedBehaviorRule[] | undefined {
  const policy = resolveBehaviorPolicy(config);
  if (!policy?.rules || policy.rules.length === 0) {
    return undefined;
  }
  return policy.rules.map(resolveRule);
}

// ---------------------------------------------------------------------------
// Prompt builder  (Layer 2)
// ---------------------------------------------------------------------------

/**
 * Build the `enforce:` prompt block to inject into the system prompt.
 *
 * Returns an empty string when there are no rules so callers can always
 * append the result unconditionally.
 */
export function buildBehaviorPolicyPrompt(rules: ResolvedBehaviorRule[] | undefined): string {
  if (!rules || rules.length === 0) {
    return "";
  }

  const parts: string[] = [
    "",
    "The following behavior rules are enforced for this session.",
    "You MUST comply with every <enforce> directive below.",
  ];

  for (const rule of rules) {
    const tag = rule.mode === "guide" ? "guide" : "enforce";
    parts.push("");
    parts.push(`  <${tag} id="${escapeXml(rule.id)}">`);
    if (rule.description) {
      parts.push(`    ${escapeXml(rule.description)}`);
    }
    parts.push(`    ${escapeXml(rule.enforce)}`);
    parts.push(`  </${tag}>`);
  }

  const result = parts.join("\n");
  return result.length > MAX_PROMPT_CHARS
    ? result.slice(0, MAX_PROMPT_CHARS) + "\n  <!-- [behavior-policy truncated] -->"
    : result;
}

// ---------------------------------------------------------------------------
// Output validation  (Layer 3)
// ---------------------------------------------------------------------------

type BehaviorPolicyViolation = {
  ruleId: string;
  severity: "violation" | "suggestion";
  message: string;
  evidence?: string;
};

type BehaviorPolicyOutputResult =
  | { kind: "pass"; violations?: BehaviorPolicyViolation[] }
  | { kind: "block"; reason: string; violations: BehaviorPolicyViolation[] }
  | { kind: "error"; message: string };

/**
 * Validate model output against active behavior rules.
 *
 * When policy has an `exec` command configured, delegates to the external
 * policy binary.  Otherwise performs built-in heuristics (basic string-match
 * checks for the most common classes of violations).
 *
 * Returns `{ kind: "pass" }` when no rules are active.
 */
export async function validateBehaviorOutput(params: {
  config?: OpenClawConfig;
  rules: ResolvedBehaviorRule[] | undefined;
  output: string;
  logger?: {
    debug?: (message: string) => void;
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}): Promise<BehaviorPolicyOutputResult> {
  if (!params.rules || params.rules.length === 0) {
    return { kind: "pass" };
  }

  const policy = resolveBehaviorPolicy(params.config);
  const exec = policy?.exec;

  if (exec) {
    return validateViaExternalCommand({
      exec,
      rules: params.rules,
      output: params.output,
      logger: params.logger,
    });
  }

  // Built-in heuristic check (Layer 2 only — no hard blocking without exec).
  // This gives the model a "second chance" to self-correct.
  const violations: BehaviorPolicyViolation[] = [];
  for (const rule of params.rules) {
    if (rule.mode === "guide") {
      continue;
    }
    const violation = checkBuiltin(rule, params.output);
    if (violation) {
      violations.push(violation);
    }
  }

  if (violations.length > 0) {
    return {
      kind: "pass",
      violations,
    };
  }

  return { kind: "pass" };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Built-in heuristic violation check.
 *
 * Scans for the most obvious pattern: the model output contains something the
 * rule says it shouldn't.  This is intentionally simple — the external
 * `exec` path handles serious enforcement.
 */
function checkBuiltin(rule: ResolvedBehaviorRule, output: string): BehaviorPolicyViolation | null {
  // Extract key constraint phrases from the enforce text.
  const keywords = extractKeywords(rule.enforce);
  if (keywords.length === 0) {
    return null;
  }

  const lowerOutput = output.toLowerCase();

  // Negative rules: things the agent MUST NOT do.
  const negations = keywords.filter((k) =>
    /^(not|never|don't|do not|must not|should not)/i.test(k),
  );
  for (const negation of negations) {
    const stripped = negation.replace(/^(not|never|don't|do not|must not|should not)\s*/i, "");
    if (!stripped) {
      continue;
    }
    if (lowerOutput.includes(stripped.toLowerCase())) {
      return {
        ruleId: rule.id,
        severity: "suggestion",
        message: `Output may conflict with enforce rule "${rule.id}": contains "${stripped}"`,
        evidence: `rule: ${rule.enforce}`,
      };
    }
  }

  return null;
}

function extractKeywords(text: string): string[] {
  // Simple split on common connectors and punctuation.
  const words = text
    .split(/[,.;:!?\n]+/)
    .map((w) => w.trim())
    .filter(Boolean);
  // Only return substantives (longer phrases that carry meaning).
  return words.filter((w) => w.length > 10);
}

// ---------------------------------------------------------------------------
// External command validation
// ---------------------------------------------------------------------------

type BehaviorPolicyExecConfig = NonNullable<BehaviorPolicyConfig["exec"]>;

async function validateViaExternalCommand(params: {
  exec: BehaviorPolicyExecConfig;
  rules: ResolvedBehaviorRule[];
  output: string;
  logger?: {
    debug?: (message: string) => void;
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}): Promise<BehaviorPolicyOutputResult> {
  let runCommandWithTimeout: typeof import("../process/exec.js").runCommandWithTimeout;
  try {
    runCommandWithTimeout = (await import("../process/exec.js")).runCommandWithTimeout;
  } catch (err) {
    return {
      kind: "error",
      message: `Failed to load exec module: ${formatErrorMessage(err)}`,
    };
  }

  const input = JSON.stringify({
    protocolVersion: 1,
    rules: params.rules.map((r) => ({
      id: r.id,
      enforce: r.enforce,
      mode: r.mode,
    })),
    output: params.output,
  });

  const timeoutMs = params.exec.timeoutMs ?? 10_000;

  let result: Awaited<ReturnType<typeof runCommandWithTimeout>>;
  try {
    result = await runCommandWithTimeout([params.exec.command, ...(params.exec.args ?? [])], {
      env: params.exec.env,
      timeoutMs,
      input,
    });
  } catch (err) {
    params.logger?.error?.(`Behavior policy exec error: ${formatErrorMessage(err)}`);
    // Fail open: don't block the response on infrastructure errors.
    return { kind: "pass" };
  }

  if (result.code !== 0) {
    params.logger?.warn?.(
      `Behavior policy exec exited ${result.code}: ${(result.stderr ?? "").slice(0, 500)}`,
    );
    // Fail open.
    return { kind: "pass" };
  }

  try {
    return parsePolicyResponse(result.stdout ?? "", params.logger);
  } catch (err) {
    params.logger?.error?.(`Behavior policy parse error: ${formatErrorMessage(err)}`);
    return { kind: "pass" };
  }
}

function parsePolicyResponse(
  stdout: string,
  logger?: {
    debug?: (message: string) => void;
    warn?: (message: string) => void;
  },
): BehaviorPolicyOutputResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { kind: "pass" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    logger?.warn?.("Behavior policy exec returned invalid JSON");
    return { kind: "pass" };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "pass" };
  }

  const record = parsed as Record<string, unknown>;
  const decision = record.decision;

  if (decision === "allow") {
    return { kind: "pass" };
  }

  if (decision !== "block") {
    logger?.warn?.(`Behavior policy exec: unexpected decision "${String(decision)}"`);
    return { kind: "pass" };
  }

  const reason = typeof record.reason === "string" ? record.reason.trim() : "Policy violation";
  const rawViolations = Array.isArray(record.violations) ? record.violations : [];
  const violations: BehaviorPolicyViolation[] = rawViolations
    .map(normalizeViolation)
    .filter((v): v is BehaviorPolicyViolation => v !== null);

  return {
    kind: "block",
    reason,
    violations,
  };
}

function normalizeViolation(value: unknown): BehaviorPolicyViolation | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const v = value as Record<string, unknown>;
  const ruleId = typeof v.ruleId === "string" ? v.ruleId.trim() : "";
  const message = typeof v.message === "string" ? v.message.trim() : "";
  if (!ruleId || !message) {
    return null;
  }
  const severity = v.severity === "suggestion" ? "suggestion" : "violation";
  const evidence = typeof v.evidence === "string" ? v.evidence.trim() : undefined;
  return { ruleId, severity, message, ...(evidence ? { evidence } : {}) };
}
