/**
 * Generate subagent.smt2
 */

import type { ParsedAll } from "../types.js";

function tc(id: string): string {
  return `${id}_`;
}

export function emitSubagentSmt2(data: ParsedAll): string {
  const { policies } = data;
  const denyAlways = policies.subagentDenyAlways;
  const denyLeaf = policies.subagentDenyLeaf;

  const lines: string[] = [];
  const w = (s: string) => lines.push(s);

  w(`; ============================================================================`);
  w(`; subagent.smt2 — Subagent Deny List`);
  w(`; ============================================================================`);
  w(`; Models resolveSubagentToolPolicy from pi-tools.policy.ts.`);
  w(`;`);
  w(`; Deny list structure:`);
  w(`;   SUBAGENT_TOOL_DENY_ALWAYS — denied at all depths`);
  w(`;   SUBAGENT_TOOL_DENY_LEAF   — additionally denied at leaf depth`);
  w(`;`);
  w(`; Override semantics (two levels):`);
  w(`;   1. resolveSubagentToolPolicy builds explicitAllow = union(allow, alsoAllow)`);
  w(`;      and removes matching tools from the base deny list.`);
  w(`;   2. makeToolPolicyMatcher is deny-first on the pruned deny list.`);
  w(`;   Combined effect: explicitAllow CAN override default deny entries.`);
  w(`;`);
  w(`; Faithful to: pi-tools.policy.ts (resolveSubagentToolPolicy)`);
  w(`; ============================================================================`);
  w(``);
  w(`; Requires tools.smt2 to be loaded first.`);
  w(``);

  // 1. deny_always
  w(`; --------------------------------------------------------------------------`);
  w(`; 1. SUBAGENT_TOOL_DENY_ALWAYS`);
  w(`; --------------------------------------------------------------------------`);
  w(`; Always denied for subagents:`);
  w(`;   ${denyAlways.join(", ")}`);
  w(``);
  w(`(define-fun subagent_deny_always ((t Tool)) Bool`);
  if (denyAlways.length === 0) {
    w(`  false)`);
  } else if (denyAlways.length === 1) {
    w(`  (= t ${tc(denyAlways[0])}))`);
  } else {
    w(`  (or ${denyAlways.map((id) => `(= t ${tc(id)})`).join("\n      ")}))`);
  }
  w(``);

  // 2. deny_leaf
  w(`; --------------------------------------------------------------------------`);
  w(`; 2. SUBAGENT_TOOL_DENY_LEAF (additional)`);
  w(`; --------------------------------------------------------------------------`);
  w(`; Additional denies at leaf depth:`);
  w(`;   ${denyLeaf.join(", ")}`);
  w(``);
  w(`(define-fun subagent_deny_leaf_extra ((t Tool)) Bool`);
  if (denyLeaf.length === 0) {
    w(`  false)`);
  } else if (denyLeaf.length === 1) {
    w(`  (= t ${tc(denyLeaf[0])}))`);
  } else {
    w(`  (or ${denyLeaf.map((id) => `(= t ${tc(id)})`).join("\n      ")}))`);
  }
  w(``);
  w(`; Combined leaf deny (always + leaf extras)`);
  w(`(define-fun subagent_deny_leaf ((t Tool)) Bool`);
  w(`  (or (subagent_deny_always t)`);
  w(`      (subagent_deny_leaf_extra t)))`);
  w(``);

  // 3. Depth
  w(`; --------------------------------------------------------------------------`);
  w(`; 3. Depth and Leaf Calculation`);
  w(`; --------------------------------------------------------------------------`);
  w(``);
  w(`(declare-const depth Int)`);
  w(`(declare-const max_spawn_depth Int)`);
  w(``);
  w(`; is_leaf = depth >= max(1, floor(maxSpawnDepth))`);
  w(`; Since maxSpawnDepth is typically a positive integer, max(1, floor(x)) = max(1, x)`);
  w(`(declare-const effective_max_depth Int)`);
  w(`(assert (= effective_max_depth (ite (>= max_spawn_depth 1) max_spawn_depth 1)))`);
  w(``);
  w(`(declare-const is_leaf Bool)`);
  w(`(assert (= is_leaf (>= depth effective_max_depth)))`);
  w(``);
  w(`; Base deny set selection based on depth`);
  w(`(define-fun subagent_base_deny ((t Tool)) Bool`);
  w(`  (ite is_leaf`);
  w(`    (subagent_deny_leaf t)`);
  w(`    (subagent_deny_always t)))`);
  w(``);

  // 4. explicitAllow override
  w(`; --------------------------------------------------------------------------`);
  w(`; 4. explicitAllow Override + Allowlist Activation`);
  w(`; --------------------------------------------------------------------------`);
  w(`; resolveSubagentToolPolicy builds explicitAllow = union(allow, alsoAllow)`);
  w(`; and removes matching tools from the base deny list before passing it to`);
  w(`; makeToolPolicyMatcher. This means explicitAllow CAN override default`);
  w(`; deny entries.`);
  w(`;`);
  w(`; When the runtime subagent allow list (tools.subagents.tools.allow) is`);
  w(`; configured, makeToolPolicyMatcher also enforces an allow-only mode where`);
  w(`; every tool must match the allowlist after the deny check. We model that`);
  w(`; via allowlist_active + allowlist_allows.`);
  w(``);
  w(`(declare-fun explicit_allow (Tool) Bool) ; union of allow + alsoAllow`);
  w(`(declare-fun allowlist_active () Bool) ; allow array has entries`);
  w(`(declare-fun allowlist_allows (Tool) Bool) ; matches allow entries`);
  w(``);

  // 5. Effective deny (after explicitAllow pruning)
  w(`; --------------------------------------------------------------------------`);
  w(`; 5. Effective Subagent Deny`);
  w(`; --------------------------------------------------------------------------`);
  w(`; A tool is effectively denied iff it's in the base deny AND NOT in`);
  w(`; explicit_allow. This models the deny list pruning in`);
  w(`; resolveSubagentToolPolicy (baseDeny.filter(t => !explicitAllow.has(t))).`);
  w(``);
  w(`(define-fun subagent_effective_deny ((t Tool)) Bool`);
  w(`  (and (subagent_base_deny t)`);
  w(`       (not (explicit_allow t))))`);
  w(``);
  w(`; A tool passes the subagent gate iff it's NOT effectively denied AND,`);
  w(`; when an allowlist is active, it matches allowlist_allows. This mirrors`);
  w(`; makeToolPolicyMatcher (deny-first, then allowlist if configured).`);
  w(`(define-fun passes_subagent_gate ((t Tool)) Bool`);
  w(`  (and (not (subagent_effective_deny t))`);
  w(`       (or (not allowlist_active)`);
  w(`           (allowlist_allows t))))`);
  w(``);

  // 6. Full policy
  w(`; --------------------------------------------------------------------------`);
  w(`; 6. Full Subagent Policy`);
  w(`; --------------------------------------------------------------------------`);
  w(`; For the full model, compose with pipeline.smt2:`);
  w(`;   subagent_accessible(t) = pipeline_allows(t) ∧ passes_subagent_gate(t)`);
  w(``);

  // Smoke tests
  w(`; --------------------------------------------------------------------------`);
  w(`; Smoke test 1: gateway denied at orchestrator depth (no override)`);
  w(`; --------------------------------------------------------------------------`);
  w(`(push 1)`);
  w(`(assert (not allowlist_active))`);
  w(`(assert (= depth 1))`);
  w(`(assert (= max_spawn_depth 2))`);
  w(`(assert (not (explicit_allow gateway_)))`);
  w(`(assert (passes_subagent_gate gateway_))`);
  w(`(check-sat) ; Expected: unsat (gateway in deny_always, not overridden)`);
  w(`(pop 1)`);
  w(``);
  w(`; Smoke test 2: sessions_spawn allowed at orchestrator depth (leaf-only deny)`);
  w(`(push 1)`);
  w(`(assert (not allowlist_active))`);
  w(`(assert (= depth 1))`);
  w(`(assert (= max_spawn_depth 2))`);
  w(`(assert (not (explicit_allow sessions_spawn_)))`);
  w(`(assert (not (passes_subagent_gate sessions_spawn_)))`);
  w(`(check-sat) ; Expected: unsat (sessions_spawn only in leaf deny, depth 1 is not leaf)`);
  w(`(pop 1)`);
  w(``);
  w(`; Smoke test 3: sessions_spawn denied at leaf depth`);
  w(`(push 1)`);
  w(`(assert (not allowlist_active))`);
  w(`(assert (= depth 2))`);
  w(`(assert (= max_spawn_depth 2))`);
  w(`(assert (not (explicit_allow sessions_spawn_)))`);
  w(`(assert (passes_subagent_gate sessions_spawn_))`);
  w(`(check-sat) ; Expected: unsat (sessions_spawn in leaf deny, depth 2 is leaf)`);
  w(`(pop 1)`);
  w(``);
  w(`; Smoke test 4: explicit_allow overrides a deny`);
  w(`(push 1)`);
  w(`(assert (not allowlist_active))`);
  w(`(assert (= depth 1))`);
  w(`(assert (= max_spawn_depth 2))`);
  w(`(assert (explicit_allow memory_search_))`);
  w(`(assert (not (passes_subagent_gate memory_search_)))`);
  w(`(check-sat) ; Expected: unsat (memory_search denied but overridden by explicit_allow)`);
  w(`(pop 1)`);
  w(``);
  w(`; Smoke test 5: allowlist_active blocks a tool not in allowlist`);
  w(`(push 1)`);
  w(`(assert allowlist_active)`);
  w(`(assert (= depth 1))`);
  w(`(assert (= max_spawn_depth 2))`);
  w(`(assert (not (subagent_effective_deny browser_)))`);
  w(`(assert (not (allowlist_allows browser_)))`);
  w(`(assert (passes_subagent_gate browser_))`);
  w(`(check-sat) ; Expected: unsat (allowlist active, browser not allowed)`);
  w(`(pop 1)`);
  w(``);
  w(`; Smoke test 6: allowlist allows a matching tool`);
  w(`(push 1)`);
  w(`(assert allowlist_active)`);
  w(`(assert (= depth 1))`);
  w(`(assert (= max_spawn_depth 2))`);
  w(`(assert (allowlist_allows sessions_spawn_))`);
  w(`(assert (passes_subagent_gate sessions_spawn_))`);
  w(`(check-sat) ; Expected: sat (allowlist grants access when not denied)`); // wait to check unsat? we want to show allowed -> sat (should not contradictory). But we have `(assert (passes_subagent_gate sessions_spawn_))` and expect sat as consistent. maybe comment accordingly.
  w(`(pop 1)`);
  w(``);
  w(`(echo "subagent.smt2 loaded successfully")`);

  return lines.join("\n") + "\n";
}
