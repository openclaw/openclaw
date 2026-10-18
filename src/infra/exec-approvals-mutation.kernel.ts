import { mergeExecApprovalsSocketDefaults } from "./exec-approvals-config.js";
import type {
  ExecApprovalsAgent,
  ExecApprovalsDefaults,
  ExecApprovalsFile,
} from "./exec-approvals-core.js";
import { maxAsk, minSecurity } from "./exec-approvals-policy.js";
import { resolveExecApprovalsFromFileInternal } from "./exec-approvals-resolver.js";

export type ExecApprovalsUpdate =
  | { kind: "replace"; file: ExecApprovalsFile; preserveSocket?: boolean }
  | { kind: "ensure-agent"; agentId: string; policy: ExecApprovalsAgent }
  | {
      kind: "rollback-defaults";
      original: ExecApprovalsFile;
      written: ExecApprovalsFile;
      policy: Pick<ExecApprovalsDefaults, "security" | "ask" | "askFallback">;
    };

/** Apply the requested edit to the transaction's current policy, never a host callback. */
export function applyExecApprovalsUpdate(
  file: ExecApprovalsFile,
  update: ExecApprovalsUpdate,
): ExecApprovalsFile | null {
  if (update.kind === "replace") {
    return update.preserveSocket
      ? mergeExecApprovalsSocketDefaults({ normalized: update.file, current: file })
      : update.file;
  }
  if (update.kind === "ensure-agent") {
    return file.agents?.[update.agentId]
      ? null
      : { ...file, agents: { ...file.agents, [update.agentId]: update.policy } };
  }
  const originalDefaults = resolveExecApprovalsFromFileInternal({ file: update.original }).defaults;
  const currentDefaults = resolveExecApprovalsFromFileInternal({ file }).defaults;
  const next = structuredClone(file);
  let changed = false;
  // A whole-file rollback lost its CAS. Revert only unchanged fields without loosening policy.
  for (const field of ["security", "ask", "askFallback"] as const) {
    const currentValue = file.defaults?.[field];
    const originalValue = update.original.defaults?.[field];
    const doesNotLoosen =
      field === "ask"
        ? maxAsk(originalDefaults.ask, currentDefaults.ask) === originalDefaults.ask
        : minSecurity(originalDefaults[field], currentDefaults[field]) === originalDefaults[field];
    if (
      update.policy[field] !== undefined &&
      currentValue === update.written.defaults?.[field] &&
      currentValue !== originalValue &&
      doesNotLoosen
    ) {
      next.defaults = { ...next.defaults, [field]: originalValue };
      changed = true;
    }
  }
  return changed ? next : null;
}
