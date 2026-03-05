/**
 * Generate pipeline.smt2 — 7-step pipeline semantics.
 */

import type { ParsedAll } from "../types.js";

export function emitPipelineSmt2(data: ParsedAll): string {
  const numSteps = data.pipeline.steps.length;
  const lines: string[] = [];
  const w = (s: string) => lines.push(s);

  w(`; ============================================================================`);
  w(`; pipeline.smt2 — 7-Step Tool Policy Pipeline Semantics`);
  w(`; ============================================================================`);
  w(`; Models the sequential filtering pipeline from tool-policy-pipeline.ts.`);
  w(`; Each step has an allow set and deny set (as uninterpreted functions).`);
  w(`; A tool survives a step iff: NOT denied AND (allow is empty OR in allow).`);
  w(`; Pipeline result = survives ALL ${numSteps} steps.`);
  w(`;`);
  w(`; The ${numSteps} steps (from buildDefaultToolPolicyPipelineSteps):`);
  for (let i = 0; i < numSteps; i++) {
    const step = data.pipeline.steps[i];
    w(`;   ${i + 1}. ${step.label}`);
  }
  w(`;`);
  w(`; Faithful to: tool-policy-pipeline.ts, pi-tools.policy.ts (filterToolsByPolicy)`);
  w(`; ============================================================================`);
  w(``);
  w(`; Requires tools.smt2 to be loaded first (or include the Tool datatype).`);
  w(`; For standalone use, uncomment:`);
  w(`; (include "tools.smt2")`);
  w(``);

  // 1. Step declarations
  w(`; --------------------------------------------------------------------------`);
  w(`; 1. Step Allow/Deny as Symbolic Functions`);
  w(`; --------------------------------------------------------------------------`);
  w(`; Each step i has:`);
  w(`;   step_i_allow(t) — true if tool t is in the allow set`);
  w(`;   step_i_deny(t)  — true if tool t is in the deny set`);
  w(`;   step_i_active   — true if this step has a policy (not skipped)`);
  w(`;   step_i_allow_empty — true if allow list is empty/undefined`);
  w(``);

  const stepLabels = [
    "Profile policy",
    "Provider profile policy",
    "Global tools policy",
    "Global provider policy",
    "Per-agent policy",
    "Per-agent provider policy",
    "Group policy",
  ];

  for (let i = 1; i <= numSteps; i++) {
    w(`; Step ${i}: ${stepLabels[i - 1] ?? `Step ${i}`}`);
    w(`(declare-fun step${i}_allow (Tool) Bool)`);
    w(`(declare-fun step${i}_deny (Tool) Bool)`);
    w(`(declare-const step${i}_active Bool)`);
    w(`(declare-const step${i}_allow_empty Bool)`);
    w(``);
  }

  // 2. Survival semantics
  w(`; --------------------------------------------------------------------------`);
  w(`; 2. Survival Semantics`);
  w(`; --------------------------------------------------------------------------`);
  w(`; From filterToolsByPolicy / makeToolPolicyMatcher in pi-tools.policy.ts:`);
  w(`;   1. If tool matches any deny pattern → blocked`);
  w(`;   2. If allow is empty → allowed`);
  w(`;   3. If tool matches any allow pattern → allowed`);
  w(`;   4. Special: apply_patch passes if exec is in allow`);
  w(`;   5. Otherwise → blocked`);
  w(`;`);
  w(`; We model the core logic (steps 1-3) plus the apply_patch special case.`);
  w(``);
  w(`(define-fun survives_step ((t Tool) (active Bool) (allow_empty Bool)`);
  w(`                           (in_allow Bool) (in_deny Bool)) Bool`);
  w(`  (ite (not active)`);
  w(`    true  ; inactive step → tool passes through`);
  w(`    (and (not in_deny)`);
  w(`         (or allow_empty in_allow))))`);
  w(``);
  w(`; apply_patch special case: if exec is in allow, apply_patch also passes`);
  w(`(define-fun survives_step_with_patch`);
  w(`  ((t Tool) (active Bool) (allow_empty Bool)`);
  w(`   (in_allow Bool) (in_deny Bool) (exec_in_allow Bool)) Bool`);
  w(`  (ite (not active)`);
  w(`    true`);
  w(`    (and (not in_deny)`);
  w(`         (or allow_empty`);
  w(`             in_allow`);
  w(`             (and (= t apply_patch_) exec_in_allow)))))`);
  w(``);

  // 3. Per-step survival
  w(`; --------------------------------------------------------------------------`);
  w(`; 3. Per-Step Survival`);
  w(`; --------------------------------------------------------------------------`);
  w(``);

  for (let i = 1; i <= numSteps; i++) {
    w(`(define-fun survives_step${i} ((t Tool)) Bool`);
    w(`  (survives_step_with_patch t step${i}_active step${i}_allow_empty`);
    w(`    (step${i}_allow t) (step${i}_deny t) (step${i}_allow exec_)))`);
    w(``);
  }

  // 4. Pipeline result
  w(`; --------------------------------------------------------------------------`);
  w(`; 4. Pipeline Result: survives ALL ${numSteps} steps`);
  w(`; --------------------------------------------------------------------------`);
  w(``);
  w(`(define-fun pipeline_allows ((t Tool)) Bool`);
  w(
    `  (and ${Array.from({ length: numSteps }, (_, i) => `(survives_step${i + 1} t)`).join("\n       ")}))`,
  );
  w(``);

  // 5-7: Comments
  w(`; --------------------------------------------------------------------------`);
  w(`; 5. stripPluginOnlyAllowlist Semantics`);
  w(`; --------------------------------------------------------------------------`);
  w(`; When an allowlist contains ONLY plugin/unknown entries (no core tool entries),`);
  w(`; the allowlist is stripped (set to undefined/empty) so core tools aren't`);
  w(`; accidentally blocked.`);
  w(``);

  for (let i = 1; i <= numSteps; i++) {
    const step = data.pipeline.steps[i - 1];
    if (step.stripPluginOnlyAllowlist) {
      w(`; Step ${i} stripping constraint`);
      w(
        `(assert (=> (forall ((t Tool)) (=> (step${i}_allow t) (not (and (is_core_tool t) (passes_owner_gate t))))))`,
      );
      w(`            step${i}_allow_empty))`);
    }
  }
  w(``);
  w(`; --------------------------------------------------------------------------`);
  w(`; 6. Glob Expansion`);
  w(`; --------------------------------------------------------------------------`);
  w(`; Since Tool is a finite enumerated sort, glob patterns expand to`);
  w(`; disjunctions at model-generation time. For example:`);
  w(`;   "web_*" in deny → (step_i_deny web_search_) ∧ (step_i_deny web_fetch_)`);
  w(`;   "*" in allow → step_i_allow_empty is effectively true (matches all)`);
  w(`;`);
  w(`; The compileGlobPattern function handles three cases:`);
  w(`;   - "*" → matches all (kind: "all")`);
  w(`;   - no wildcards → exact match (kind: "exact")`);
  w(`;   - contains "*" → regex (kind: "regex")`);
  w(`;`);
  w(`; For concrete configs, globs are expanded against the 26-element tool set`);
  w(`; before encoding. In the symbolic model, we keep allow/deny as uninterpreted`);
  w(`; functions that the properties will constrain.`);
  w(``);
  w(`; --------------------------------------------------------------------------`);
  w(`; 7. Group Expansion`);
  w(`; --------------------------------------------------------------------------`);
  w(`; expandToolGroups replaces group:X entries with their member tools.`);
  w(`; This happens before glob compilation. For example:`);
  w(`;   ["group:fs", "exec"] → ["read", "write", "edit", "apply_patch", "exec"]`);
  w(`;`);
  w(`; In concrete configs, group expansion is done by the translator.`);
  w(`; In the symbolic model, groups are modeled in tools.smt2.`);
  w(``);

  // Smoke tests
  w(`; --------------------------------------------------------------------------`);
  w(`; Smoke test: If all steps are inactive, every tool passes`);
  w(`; --------------------------------------------------------------------------`);
  w(`(push 1)`);
  for (let i = 1; i <= numSteps; i++) {
    w(`(assert (not step${i}_active))`);
  }
  w(`; Now pipeline_allows should be true for any tool`);
  w(`(assert (not (pipeline_allows exec_)))`);
  w(`(check-sat) ; Expected: unsat (all inactive → everything passes)`);
  w(`(pop 1)`);
  w(``);
  w(`; Smoke test 2: A deny at any active step blocks the tool`);
  w(`(push 1)`);
  w(`(assert step3_active)`);
  w(`(assert (step3_deny exec_))`);
  w(`(assert (pipeline_allows exec_))`);
  w(`(check-sat) ; Expected: unsat (denied at step 3 → can't pass)`);
  w(`(pop 1)`);
  w(``);
  w(`(echo "pipeline.smt2 loaded successfully")`);

  return lines.join("\n") + "\n";
}
