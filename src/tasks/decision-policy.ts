export type ActionDecision = "allowed" | "needs_decision";

export type ActionRisk = "low" | "medium" | "high" | "hard-boundary";

export type ActionClassification = {
  decision: ActionDecision;
  risk: ActionRisk;
  action: string;
  reason: string;
  safeAlternative: string;
  approvalTarget: string;
  rollback: string;
};

const HARD_BOUNDARY_RULES: Array<{ code: string; pattern: RegExp; reason: string }> = [
  {
    code: "destructive-delete",
    pattern: /\b(delete|purge|destroy|wipe|remove permanently|unrecoverable)\b/i,
    reason: "destructive or unrecoverable change",
  },
  {
    code: "external-send",
    pattern: /\b(send|deliver|message|email|post to|publish to|notify external|notify user)\b/i,
    reason: "external communication",
  },
  {
    code: "release-publish-deploy",
    pattern: /\b(push|publish|deploy|release|ship|npm publish|git push)\b/i,
    reason: "external release or repository side effect",
  },
  {
    code: "auth-account-payment",
    pattern: /\b(auth|account|payment|billing|credential|token|oauth|password)\b/i,
    reason: "auth, account, credential, or payment boundary",
  },
  {
    code: "remote-write-job",
    pattern: /\b(remote write|submit job|slurm|cluster|cloud job|remote job|production job)\b/i,
    reason: "remote write or remote compute job",
  },
  {
    code: "memory-write",
    pattern: /\b(memory write|write memory|promote memory|codex memory|openclaw memory promote)\b/i,
    reason: "durable memory write",
  },
  {
    code: "canonical-rule-mutation",
    pattern:
      /\b(AGENTS|canonical skill|skill-governance|persistent rule|global rule|governance)\b/i,
    reason: "canonical skill, governance, or rule mutation",
  },
  {
    code: "daemon-monitor",
    pattern: /\b(daemon|cron|background monitor|launchd|keep watching|persistent monitor)\b/i,
    reason: "persistent process or monitor creation",
  },
  {
    code: "shell-destructive-or-remote",
    pattern:
      /\b(rm\s+-rf|git\s+reset\s+--hard|launchctl\s+load|kubectl\s+apply|terraform\s+apply|scp\b|rsync\b)\b/i,
    reason: "destructive, persistent, or remote shell operation",
  },
];

const LOW_RISK_LOCAL_RULES: RegExp[] = [
  /\b(read|inspect|list|show|status|summarize|classify|preview|dry-run|dry run)\b/i,
  /\b(update local docs|edit local docs|write local receipt|write local report|record local audit)\b/i,
  /\b(test|format|typecheck|build local|compile local)\b/i,
  /\b(post-process local logs|update task notify policy)\b/i,
];

function normalizeActionText(params: { action: string; title?: string; reason?: string }): string {
  return [params.action, params.title ?? "", params.reason ?? ""].join(" ").trim();
}

export function classifyActionRequest(params: {
  action: string;
  title?: string;
  reason?: string;
}): ActionClassification {
  const action = params.action.trim();
  const text = normalizeActionText(params);
  const hardBoundary = HARD_BOUNDARY_RULES.find((rule) => rule.pattern.test(text));
  if (hardBoundary) {
    return {
      decision: "needs_decision",
      risk: "hard-boundary",
      action,
      reason: hardBoundary.reason,
      safeAlternative: "produce a local review packet and wait for explicit approval",
      approvalTarget: "operator",
      rollback: "no side effect has been performed; keep the action queued until approved",
    };
  }
  if (!LOW_RISK_LOCAL_RULES.some((rule) => rule.test(text))) {
    return {
      decision: "needs_decision",
      risk: "hard-boundary",
      action,
      reason: "action is outside the explicit low-risk local allowlist",
      safeAlternative: "produce a local review packet and wait for explicit approval",
      approvalTarget: "operator",
      rollback: "no side effect has been performed; keep the action queued until approved",
    };
  }
  return {
    decision: "allowed",
    risk: "low",
    action,
    reason: "local, reversible, auditable, explicit-scope action",
    safeAlternative: "record the local action and verification evidence",
    approvalTarget: "none",
    rollback: "revert the local file/state change from the recorded diff or artifact",
  };
}
