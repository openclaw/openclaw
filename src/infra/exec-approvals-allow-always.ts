import { sha256HexPrefixCore } from "./crypto-digest.js";
import {
  buildExecApprovalPolicyRuleKey,
  canonicalizeExecApprovalPolicyRules,
} from "./exec-approval-policy-snapshot.js";
import type { ExecApprovalPolicySnapshot } from "./exec-approval-policy-snapshot.js";
import { resolveAllowAlwaysPatternEntries } from "./exec-approvals-allowlist.js";
import type {
  AllowAlwaysPersistenceDecision,
  AllowAlwaysPersistenceReason,
} from "./exec-approvals-contracts.js";
import type { ExecApprovalsFile } from "./exec-approvals-core.js";
import { resolveExecApprovalsFromFileInternal } from "./exec-approvals-resolver.js";
import type { ExecAllowlistEntry } from "./exec-approvals.types.js";
import type { ExecAuthorizationPlan } from "./exec-authorization-plan.js";
import { isCwdBoundHashedArgPattern } from "./exec-command-resolution.js";
import {
  extractBindableShellWrapperInlineCommand,
  isShellWrapperInvocation,
} from "./exec-wrapper-resolution.js";
import {
  hasPosixInteractiveStartupBeforeInlineCommand,
  hasPosixLoginStartupBeforeInlineCommand,
  POSIX_INLINE_COMMAND_FLAGS,
} from "./shell-inline-command.js";

export function hasDurableExecApproval(params: {
  analysisOk: boolean;
  segmentAllowlistEntries: Array<ExecAllowlistEntry | null>;
  allowlist?: readonly ExecAllowlistEntry[];
  commandText?: string | null;
}): boolean {
  return (
    hasExactCommandDurableExecApproval({
      allowlist: params.allowlist,
      commandText: params.commandText,
    }) ||
    (params.analysisOk &&
      params.segmentAllowlistEntries.length > 0 &&
      params.segmentAllowlistEntries.every((entry) => entry?.source === "allow-always"))
  );
}

// Digest input is the trimmed command text only. Shipped approvals files
// already hold `=command:` entries in this format; changing the input
// silently orphans every persisted exact-command grant.
function buildDurableCommandApprovalPattern(commandText: string): string {
  return `=command:${sha256HexPrefixCore(commandText, 16)}`;
}

function buildNodeCommandApprovalPattern(commandText: string): string {
  return `=node-command:${sha256HexPrefixCore(commandText, 16)}`;
}

export function hasNodeCommandAllowAlwaysMarker(params: {
  allowlist?: readonly ExecAllowlistEntry[];
  commandText?: string | null;
}): boolean {
  const normalizedCommand = params.commandText?.trim();
  if (!normalizedCommand) {
    return false;
  }
  const commandPattern = buildNodeCommandApprovalPattern(normalizedCommand);
  return (params.allowlist ?? []).some(
    (entry) => entry.source === "allow-always" && entry.pattern === commandPattern,
  );
}

export function hasExactCommandDurableExecApproval(params: {
  allowlist?: readonly ExecAllowlistEntry[];
  commandText?: string | null;
}): boolean {
  const normalizedCommand = params.commandText?.trim();
  if (!normalizedCommand) {
    return false;
  }
  const commandPattern = buildDurableCommandApprovalPattern(normalizedCommand);
  return (params.allowlist ?? []).some(
    (entry) =>
      entry.source === "allow-always" &&
      (entry.pattern === commandPattern ||
        (typeof entry.commandText === "string" && entry.commandText.trim() === normalizedCommand)),
  );
}

type DurableExecApprovalRequirement = "exact-command" | "segment-allowlist";

/** Callers pass whether their final, post-gate authorization depends on a durable grant. */
export function resolveDurableExecApprovalRequirement(params: {
  durableApprovalRequired: boolean;
  allowlist?: readonly ExecAllowlistEntry[];
  commandText?: string | null;
}): DurableExecApprovalRequirement | null {
  if (!params.durableApprovalRequired) {
    return null;
  }
  return hasExactCommandDurableExecApproval({
    allowlist: params.allowlist,
    commandText: params.commandText,
  })
    ? "exact-command"
    : "segment-allowlist";
}

export function buildAllowlistEntryMatchKey(
  entry: Pick<ExecAllowlistEntry, "pattern" | "argPattern">,
): string {
  return JSON.stringify([entry.pattern, entry.argPattern ?? null]);
}

/** Captures effective file policy while excluding ids and mutable usage metadata. */
export function createExecApprovalPolicySnapshot(params: {
  file: ExecApprovalsFile;
  agentId: string | undefined;
}): ExecApprovalPolicySnapshot {
  // Runtime overrides are deliberately absent: the snapshot protects the
  // persisted policy that may change while a human approval is pending.
  const resolved = resolveExecApprovalsFromFileInternal({
    file: params.file,
    agentId: params.agentId,
  });
  return {
    security: resolved.agent.security,
    ask: resolved.agent.ask,
    askFallback: resolved.agent.askFallback,
    autoAllowSkills: resolved.agent.autoAllowSkills,
    allowlistRules: canonicalizeExecApprovalPolicyRules(
      resolved.allowlist.map((entry) => {
        const rule: ExecApprovalPolicySnapshot["allowlistRules"][number] = {
          pattern: entry.pattern,
        };
        if (entry.argPattern !== undefined) {
          rule.argPattern = entry.argPattern;
        }
        if (entry.source === "allow-always") {
          rule.source = entry.source;
        }
        return rule;
      }),
    ),
  };
}

export function isExecApprovalPolicySnapshotCurrent(
  expected: ExecApprovalPolicySnapshot,
  current: ExecApprovalPolicySnapshot,
): boolean {
  const currentRuleKeys = new Set(current.allowlistRules.map(buildExecApprovalPolicyRuleKey));
  return (
    expected.security === current.security &&
    expected.ask === current.ask &&
    expected.askFallback === current.askFallback &&
    expected.autoAllowSkills === current.autoAllowSkills &&
    // Concurrent operator-approved grants are additive. Preserve them while
    // accepting an in-place allow-always upgrade of the same rule. Revocations
    // and reverse source downgrades still remove an expected authority.
    expected.allowlistRules.every((rule) => {
      const key = buildExecApprovalPolicyRuleKey(rule);
      if (currentRuleKeys.has(key)) {
        return true;
      }
      return (
        rule.source === undefined &&
        currentRuleKeys.has(buildExecApprovalPolicyRuleKey({ ...rule, source: "allow-always" }))
      );
    })
  );
}

export function resolveAllowAlwaysPatternCoverage(
  params: Parameters<typeof resolveAllowAlwaysPatternEntries>[0],
) {
  const byKey = new Map<string, ReturnType<typeof resolveAllowAlwaysPatternEntries>[number]>();
  let representedSegmentCount = 0;
  for (const segment of params.segments) {
    const shellWrapper = isShellWrapperInvocation(segment.argv);
    const segmentPatterns = resolveAllowAlwaysPatternEntries({
      segments: [segment],
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
      strictInlineEval: params.strictInlineEval,
    });
    if (segmentPatterns.length === 0) {
      continue;
    }
    if (!shellWrapper) {
      representedSegmentCount += 1;
    }
    for (const pattern of segmentPatterns) {
      byKey.set(`${pattern.pattern}\x00${pattern.argPattern ?? ""}`, pattern);
    }
  }
  return {
    complete: params.segments.length > 0 && representedSegmentCount === params.segments.length,
    patterns: [...byKey.values()],
  };
}

function hasRuntimeShellPayload(argv: readonly string[]): boolean {
  const inlineCommand = extractBindableShellWrapperInlineCommand([...argv]);
  return Boolean(
    inlineCommand &&
    (/(?:\$[A-Za-z0-9_@*?#$!-]|\$\{|`|\$\()/u.test(inlineCommand) ||
      hasPosixInteractiveStartupBeforeInlineCommand(argv, POSIX_INLINE_COMMAND_FLAGS) ||
      hasPosixLoginStartupBeforeInlineCommand(argv, POSIX_INLINE_COMMAND_FLAGS)),
  );
}

function resolvePlanPersistenceState(plan: ExecAuthorizationPlan | undefined): {
  reusablePatternsAllowed: boolean;
  reasons: AllowAlwaysPersistenceReason[];
} {
  if (!plan) {
    return { reusablePatternsAllowed: true, reasons: [] };
  }
  if (!plan.ok) {
    return { reusablePatternsAllowed: false, reasons: ["unplanned"] };
  }
  const reasons = new Set<AllowAlwaysPersistenceReason>();
  let reusablePatternsAllowed = true;
  const candidates = plan.groups.flatMap((group) => group.candidates);
  for (const candidate of candidates) {
    if (candidate.trustMode === "prompt-only") {
      reasons.add("prompt-only");
    }
    if (candidate.trustMode === "exact-command") {
      // Durable `=command:` entries are command-text-only and cannot bind
      // cwd, env, or PATH, so planner exact-command candidates stay one-shot.
      reasons.add("no-reusable-pattern");
    }
    if (candidate.trustMode === "executable" && !candidate.allowAlways) {
      reasons.add("no-reusable-pattern");
    }
    reusablePatternsAllowed = reusablePatternsAllowed && candidate.allowAlways;
    if (hasRuntimeShellPayload(candidate.sourceSegment.argv)) {
      reasons.add("runtime-payload");
    }
    if (
      candidate.transport.kind === "shell-wrapper" &&
      hasRuntimeShellPayload(candidate.transport.wrapperArgv)
    ) {
      reasons.add("runtime-payload");
    }
  }
  return {
    reusablePatternsAllowed,
    reasons: [...reasons],
  };
}

export function resolveAllowAlwaysPersistenceDecision(
  params: Parameters<typeof resolveAllowAlwaysPatternCoverage>[0] & {
    commandText?: string | null;
    authorizationPlan?: ExecAuthorizationPlan;
    runtimePayload?: boolean;
    preparedCoverage?: ReturnType<typeof resolveAllowAlwaysPatternCoverage> | null;
  },
): AllowAlwaysPersistenceDecision {
  const planPersistence = resolvePlanPersistenceState(params.authorizationPlan);
  const reasons = new Set<AllowAlwaysPersistenceReason>(planPersistence.reasons);
  if (params.runtimePayload === true) {
    reasons.add("runtime-payload");
  }
  const commandText = params.commandText?.trim();
  const hardReasons = [...reasons].filter((reason) => reason !== "no-reusable-pattern");
  if (hardReasons.length > 0) {
    return { kind: "one-shot", reasons: hardReasons };
  }

  if (params.preparedCoverage?.complete === true && params.preparedCoverage.patterns.length > 0) {
    return {
      kind: "patterns",
      patterns: params.preparedCoverage.patterns,
      ...(commandText ? { commandText } : {}),
    };
  }

  if (planPersistence.reusablePatternsAllowed) {
    const coverage = resolveAllowAlwaysPatternCoverage({
      segments: params.segments,
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
      strictInlineEval: params.strictInlineEval,
    });
    if (coverage.patterns.length > 0) {
      return {
        kind: "patterns",
        patterns: coverage.patterns,
        ...(commandText && coverage.complete ? { commandText } : {}),
      };
    }
  }

  reasons.add("no-reusable-pattern");
  return { kind: "one-shot", reasons: [...reasons] };
}

export function applyAllowAlwaysDecision(params: {
  file: ExecApprovalsFile;
  agentId: string | undefined;
  decision: Exclude<AllowAlwaysPersistenceDecision, { kind: "one-shot" }>;
}): ExecApprovalsFile | null {
  const entries: Array<Pick<ExecAllowlistEntry, "pattern" | "argPattern">> =
    params.decision.kind === "patterns" ? [...params.decision.patterns] : [];
  const commandText = params.decision.commandText?.trim();
  if (commandText) {
    entries.push({
      pattern:
        params.decision.kind === "exact-command"
          ? buildDurableCommandApprovalPattern(commandText)
          : buildNodeCommandApprovalPattern(commandText),
    });
  }
  if (!params.agentId) {
    throw new Error("Exec allowlist update requires an explicit agent id.");
  }
  const generatedPatterns = new Set(
    entries
      .filter((entry) => isCwdBoundHashedArgPattern(entry.argPattern))
      .map((entry) => entry.pattern),
  );
  const existingAgent = params.file.agents?.[params.agentId];
  const existingAllowlist = existingAgent?.allowlist ?? [];
  let allowlist = existingAllowlist.filter(
    (entry) =>
      !(
        generatedPatterns.has(entry.pattern) &&
        entry.source === "allow-always" &&
        !isCwdBoundHashedArgPattern(entry.argPattern)
      ),
  );
  let changed = allowlist.length !== existingAllowlist.length;
  for (const entry of entries) {
    const pattern = entry.pattern.trim();
    if (!pattern) {
      continue;
    }
    const argPattern = entry.argPattern === "" ? undefined : entry.argPattern;
    const matches = (candidate: ExecAllowlistEntry) =>
      candidate.pattern === pattern && (candidate.argPattern ?? undefined) === argPattern;
    const existingEntry = allowlist.find(matches);
    if (existingEntry?.source === "allow-always") {
      continue;
    }
    const lastUsedAt = Date.now();
    if (existingEntry) {
      allowlist = allowlist.map((candidate) =>
        matches(candidate)
          ? { ...candidate, argPattern, source: "allow-always", lastUsedAt }
          : candidate,
      );
    } else {
      allowlist.push({
        id: crypto.randomUUID(),
        pattern,
        argPattern,
        source: "allow-always",
        lastUsedAt,
      });
    }
    changed = true;
  }
  return changed
    ? {
        ...params.file,
        agents: { ...params.file.agents, [params.agentId]: { ...existingAgent, allowlist } },
      }
    : null;
}
