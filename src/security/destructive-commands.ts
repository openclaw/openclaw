/**
 * Destructive command patterns for exec approval policy.
 *
 * These patterns identify commands with irreversible or high-blast-radius effects.
 * When used with `security=allowlist` + `ask=on-miss`, any command matching these
 * patterns will require explicit HIL (Human-in-the-Loop) approval before execution.
 *
 * Usage:
 *   Import DESTRUCTIVE_COMMAND_PATTERNS in exec approval policy initialization.
 *   These patterns are intentionally NOT in the default safe-bin allowlist.
 *
 * Design principles:
 *   - Allowlist-first: safe operations are pre-approved; destructive ones prompt
 *   - Prefix-matched: patterns cover the command verb + key flags, not full strings
 *   - Conservative: when in doubt, require approval
 *   - Spoofing-resistant: approval decision is bound to the session token in the
 *     gateway's approval flow, not to agent-asserted metadata
 *
 * @see exec-approvals.ts for the approval protocol
 * @see exec-safe-bin-policy.ts for the safe default allowlist
 */

/**
 * Commands that delete, destroy, or irreversibly modify Kubernetes resources.
 * Read-only kubectl commands (get, describe, logs, rollout status) are safe.
 */
export const KUBECTL_DESTRUCTIVE_PATTERNS = [
  "kubectl delete *",
  "kubectl drain *",
  "kubectl cordon *",
  "kubectl uncordon *",
  "kubectl taint *",
  "kubectl replace *",
  "kubectl apply *", // Intentionally requires approval — applies cluster state changes
  "kubectl patch *",
  "kubectl scale *",
  "kubectl rollout restart *",
  "kubectl rollout undo *",
  "kubectl label * --overwrite *",
  "kubectl annotate * --overwrite *",
] as const;

/**
 * Terraform commands that mutate infrastructure state.
 * terraform plan, init, validate are safe; apply/destroy/taint/import are not.
 */
export const TERRAFORM_DESTRUCTIVE_PATTERNS = [
  "terraform apply *",
  "terraform destroy *",
  "terraform taint *",
  "terraform untaint *",
  "terraform import *",
  "terraform state rm *",
  "terraform state mv *",
  "terraform workspace delete *",
  "terraform workspace new *",
] as const;

/**
 * GCP gcloud commands that create, update, or delete cloud resources.
 * gcloud * list/describe/get are safe.
 */
export const GCLOUD_DESTRUCTIVE_PATTERNS = [
  "gcloud * delete *",
  "gcloud * create *",
  "gcloud * update *",
  "gcloud * set *",
  "gcloud * add *",
  "gcloud * remove *",
  "gcloud * deploy *",
  "gcloud * patch *",
  "gcloud * disable *",
  "gcloud * enable *",
  "gcloud secrets versions *",
] as const;

/**
 * File system operations with irreversible effects.
 * cp, mv, mkdir, touch are safe; rm and overwrite-redirects are not.
 */
export const FILESYSTEM_DESTRUCTIVE_PATTERNS = [
  "rm *",
  "rmdir *",
  "shred *",
  "dd *",
  "truncate *",
  // Shell redirections with > (overwrite) can't be caught here —
  // handled by exec-approvals-analysis.ts shell chain analysis
] as const;

/**
 * Git operations that rewrite history or force-push to shared branches.
 * Normal git add/commit/push/pull/checkout are safe.
 */
export const GIT_DESTRUCTIVE_PATTERNS = [
  "git push *--force*",
  "git push *-f *",
  "git push origin main *",
  "git push origin master *",
  "git push origin production *",
  "git reset --hard *",
  "git clean -fd *",
  "git rebase -i *",
  "git filter-branch *",
  "git reflog delete *",
] as const;

/**
 * Database operations that mutate or destroy data.
 */
export const DATABASE_DESTRUCTIVE_PATTERNS = [
  "psql * -c *DROP*",
  "psql * -c *TRUNCATE*",
  "psql * -c *DELETE*",
  "psql * -c *ALTER*",
  "psql * -c *CREATE*",
  "mysql * -e *DROP*",
  "mysql * -e *TRUNCATE*",
  "sqlite3 * *DROP*",
] as const;

/**
 * Process signals that terminate or suspend processes.
 * SIGTERM (15) to a specific PID is usually safe; SIGKILL (-9) and broadcast
 * kills (kill -9 -1 which kills all processes) are destructive.
 */
export const PROCESS_DESTRUCTIVE_PATTERNS = [
  "kill -9 *",
  "kill -KILL *",
  "killall *",
  "pkill -9 *",
] as const;

/**
 * SSH operations that modify remote state at scale.
 * Read-only SSH commands are generally safe; mass operations are not.
 */
export const SSH_DESTRUCTIVE_PATTERNS = [
  "ssh * sudo rm *",
  "ssh * sudo systemctl disable *",
  "ssh * sudo systemctl stop *",
] as const;

/**
 * All destructive command patterns combined.
 * Use this as the basis for a HIL-required exec approval policy.
 *
 * @example
 * ```ts
 * // In exec approval initialization:
 * import { ALL_DESTRUCTIVE_PATTERNS } from "./destructive-commands.js";
 *
 * const requiresHIL = ALL_DESTRUCTIVE_PATTERNS.some(pattern =>
 *   matchAllowlist(command, [{ pattern }])
 * );
 * if (requiresHIL) {
 *   // Route to ask=always approval flow
 * }
 * ```
 */
export const ALL_DESTRUCTIVE_PATTERNS = [
  ...KUBECTL_DESTRUCTIVE_PATTERNS,
  ...TERRAFORM_DESTRUCTIVE_PATTERNS,
  ...GCLOUD_DESTRUCTIVE_PATTERNS,
  ...FILESYSTEM_DESTRUCTIVE_PATTERNS,
  ...GIT_DESTRUCTIVE_PATTERNS,
  ...DATABASE_DESTRUCTIVE_PATTERNS,
  ...PROCESS_DESTRUCTIVE_PATTERNS,
  ...SSH_DESTRUCTIVE_PATTERNS,
] as const;

export type DestructiveCommandPattern = (typeof ALL_DESTRUCTIVE_PATTERNS)[number];
