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
  w(`; subagent.smt2 — Subagent Deny Lists and alsoAllow Override`);
  w(`; ============================================================================`);
  w(`; Models resolveSubagentToolPolicy from pi-tools.policy.ts.`);
  w(`;`);
  w(`; Subagents have two tiers of denied tools:`);
  w(`;   1. SUBAGENT_TOOL_DENY_ALWAYS — always denied regardless of depth`);
  w(`;   2. SUBAGENT_TOOL_DENY_LEAF — additional denies at leaf depth`);
  w(`;`);
  w(`; Leaf detection: depth >= max(1, floor(maxSpawnDepth))`);
  w(`;`);
  w(`; The alsoAllow mechanism lets config override specific denies:`);
  w(`;   effective_deny = base_deny.filter(t => !explicitAllow.has(t))`);
  w(`;   where explicitAllow = union(allow, alsoAllow)`);
  w(`;`);
  w(`; Faithful to: pi-tools.policy.ts (resolveSubagentDenyList, resolveSubagentToolPolicy)`);
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
  w(`  (or ${denyAlways.map((id) => `(= t ${tc(id)})`).join("\n      ")}))`);
  w(``);

  // 2. deny_leaf
  w(`; --------------------------------------------------------------------------`);
  w(`; 2. SUBAGENT_TOOL_DENY_LEAF (additional)`);
  w(`; --------------------------------------------------------------------------`);
  w(`; Additional denies at leaf depth:`);
  w(`;   ${denyLeaf.join(", ")}`);
  w(``);
  w(`(define-fun subagent_deny_leaf_extra ((t Tool)) Bool`);
  w(`  (or ${denyLeaf.map((id) => `(= t ${tc(id)})`).join("\n      ")}))`);
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

  // 4. alsoAllow
  w(`; --------------------------------------------------------------------------`);
  w(`; 4. alsoAllow Override Mechanism`);
  w(`; --------------------------------------------------------------------------`);
  w(`; The config can specify tools.subagents.tools.allow and .alsoAllow.`);
  w(`; explicitAllow = union(allow, alsoAllow)`);
  w(`; Items in explicitAllow are removed from the base deny list.`);
  w(``);
  w(`(declare-fun also_allow (Tool) Bool)    ; from config alsoAllow`);
  w(`(declare-fun explicit_allow (Tool) Bool) ; union of allow + alsoAllow`);
  w(``);

  // 5. Effective deny
  w(`; --------------------------------------------------------------------------`);
  w(`; 5. Effective Subagent Deny`);
  w(`; --------------------------------------------------------------------------`);
  w(`; A tool is denied iff it's in the base deny AND NOT in explicit_allow.`);
  w(``);
  w(`(define-fun subagent_effective_deny ((t Tool)) Bool`);
  w(`  (and (subagent_base_deny t)`);
  w(`       (not (explicit_allow t))))`);
  w(``);
  w(`; A tool passes the subagent gate iff it's NOT effectively denied`);
  w(`(define-fun passes_subagent_gate ((t Tool)) Bool`);
  w(`  (not (subagent_effective_deny t)))`);
  w(``);

  // 6. Full policy
  w(`; --------------------------------------------------------------------------`);
  w(`; 6. Full Subagent Policy (deny + optional allow filtering)`);
  w(`; --------------------------------------------------------------------------`);
  w(`; The resolved policy also has an allow list (merged allow + alsoAllow).`);
  w(`; If allow is specified, tools must be in it (standard allow semantics).`);
  w(`; The deny list is the effective deny computed above.`);
  w(`;`);
  w(`; For the full model, compose with pipeline.smt2:`);
  w(`;   subagent_accessible(t) = pipeline_allows(t) ∧ passes_subagent_gate(t)`);
  w(``);

  // Smoke tests
  w(`; --------------------------------------------------------------------------`);
  w(`; Smoke test: gateway is always denied (no alsoAllow)`);
  w(`; --------------------------------------------------------------------------`);
  w(`(push 1)`);
  w(`(assert (= depth 1))`);
  w(`(assert (= max_spawn_depth 2))`);
  w(`(assert (not (explicit_allow gateway_)))`);
  w(`(assert (passes_subagent_gate gateway_))`);
  w(`(check-sat) ; Expected: unsat (gateway in deny_always, not overridden)`);
  w(`(pop 1)`);
  w(``);
  w(`; Smoke test: sessions_spawn allowed for orchestrator (depth < maxSpawnDepth)`);
  w(`(push 1)`);
  w(`(assert (= depth 1))`);
  w(`(assert (= max_spawn_depth 2))`);
  w(`(assert (not (explicit_allow sessions_spawn_)))`);
  w(`(assert (not (passes_subagent_gate sessions_spawn_)))`);
  w(`(check-sat) ; Expected: unsat (sessions_spawn NOT in deny_always, so it passes)`);
  w(`(pop 1)`);
  w(``);
  w(`; Smoke test: sessions_spawn denied at leaf depth`);
  w(`(push 1)`);
  w(`(assert (= depth 2))`);
  w(`(assert (= max_spawn_depth 2))`);
  w(`(assert (not (explicit_allow sessions_spawn_)))`);
  w(`(assert (passes_subagent_gate sessions_spawn_))`);
  w(`(check-sat) ; Expected: unsat (sessions_spawn in deny_leaf, depth=max)`);
  w(`(pop 1)`);
  w(``);
  w(`; Smoke test: alsoAllow can override a deny`);
  w(`(push 1)`);
  w(`(assert (= depth 1))`);
  w(`(assert (= max_spawn_depth 2))`);
  w(`(assert (explicit_allow memory_search_))`);
  w(`(assert (not (passes_subagent_gate memory_search_)))`);
  w(`(check-sat) ; Expected: unsat (memory_search denied but overridden by explicit_allow)`);
  w(`(pop 1)`);
  w(``);
  w(`(echo "subagent.smt2 loaded successfully")`);

  return lines.join("\n") + "\n";
}
