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
  w(`; The runtime uses a single flat deny list (DEFAULT_SUBAGENT_TOOL_DENY)`);
  w(`; applied to all subagents regardless of depth. The model retains a`);
  w(`; two-tier structure (deny_always + deny_leaf_extra) for forward`);
  w(`; compatibility; currently deny_leaf_extra is empty so both tiers`);
  w(`; produce the same deny set.`);
  w(`;`);
  w(`; Deny-first: deny always wins over allow (matches makeToolPolicyMatcher).`);
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

  // 4. Allow list (optional additional filter)
  w(`; --------------------------------------------------------------------------`);
  w(`; 4. Optional Allow List`);
  w(`; --------------------------------------------------------------------------`);
  w(`; The config can specify tools.subagents.tools.allow.`);
  w(`; If an allow list is present, only listed tools may pass.`);
  w(`; Deny always takes precedence over allow (deny-first semantics).`);
  w(``);
  w(`(declare-const has_allowlist Bool)         ; whether an allow list is configured`);
  w(`(declare-fun on_allowlist (Tool) Bool)     ; tool is in the configured allow list`);
  w(``);

  // 5. Effective gate (deny-first)
  w(`; --------------------------------------------------------------------------`);
  w(`; 5. Subagent Gate (deny-first)`);
  w(`; --------------------------------------------------------------------------`);
  w(`; Runtime semantics (makeToolPolicyMatcher in pi-tools.policy.ts):`);
  w(`;   1. If tool is in deny list → BLOCKED (unconditional)`);
  w(`;   2. If no allow list → PASS`);
  w(`;   3. If tool is in allow list → PASS`);
  w(`;   4. Otherwise → BLOCKED`);
  w(`; Deny can never be overridden by allow.`);
  w(``);
  w(`(define-fun passes_subagent_gate ((t Tool)) Bool`);
  w(`  (and (not (subagent_base_deny t))`);
  w(`       (or (not has_allowlist)`);
  w(`           (on_allowlist t))))`);
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
  w(`; Smoke test 1: gateway is always denied`);
  w(`; --------------------------------------------------------------------------`);
  w(`(push 1)`);
  w(`(assert (= depth 1))`);
  w(`(assert (= max_spawn_depth 2))`);
  w(`(assert (passes_subagent_gate gateway_))`);
  w(`(check-sat) ; Expected: unsat (gateway in deny list — unconditional)`);
  w(`(pop 1)`);
  w(``);
  w(`; Smoke test 2: sessions_spawn denied at orchestrator depth`);
  w(`(push 1)`);
  w(`(assert (= depth 1))`);
  w(`(assert (= max_spawn_depth 2))`);
  w(`(assert (passes_subagent_gate sessions_spawn_))`);
  w(`(check-sat) ; Expected: unsat (sessions_spawn in deny list)`);
  w(`(pop 1)`);
  w(``);
  w(`; Smoke test 3: sessions_spawn denied at leaf depth`);
  w(`(push 1)`);
  w(`(assert (= depth 2))`);
  w(`(assert (= max_spawn_depth 2))`);
  w(`(assert (passes_subagent_gate sessions_spawn_))`);
  w(`(check-sat) ; Expected: unsat (sessions_spawn in deny list)`);
  w(`(pop 1)`);
  w(``);
  w(`; Smoke test 4: deny wins even when tool is on allow list`);
  w(`(push 1)`);
  w(`(assert (= depth 1))`);
  w(`(assert (= max_spawn_depth 2))`);
  w(`(assert has_allowlist)`);
  w(`(assert (on_allowlist memory_search_))`);
  w(`(assert (passes_subagent_gate memory_search_))`);
  w(`(check-sat) ; Expected: unsat (memory_search denied, allow cannot override deny)`);
  w(`(pop 1)`);
  w(``);
  w(`; Smoke test 5: non-denied tool passes when on allow list`);
  w(`(push 1)`);
  w(`(assert (= depth 1))`);
  w(`(assert (= max_spawn_depth 2))`);
  w(`(assert has_allowlist)`);
  w(`(assert (on_allowlist read_))`);
  w(`(assert (not (passes_subagent_gate read_)))`);
  w(`(check-sat) ; Expected: unsat (read not denied and on allowlist, must pass)`);
  w(`(pop 1)`);
  w(``);
  w(`(echo "subagent.smt2 loaded successfully")`);

  return lines.join("\n") + "\n";
}
