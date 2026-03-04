/**
 * Generate profiles.smt2 from parsed tool catalog.
 */

import type { ParsedAll } from "../types.js";

function tc(id: string): string {
  return `${id}_`;
}

export function emitProfilesSmt2(data: ParsedAll): string {
  const { catalog } = data;
  const tools = catalog.tools;

  // Build profile -> tool list
  const profileTools = new Map<string, string[]>();
  const profileOrder = ["minimal", "coding", "messaging", "full"];
  for (const p of profileOrder) {
    profileTools.set(p, []);
  }
  for (const tool of tools) {
    for (const p of tool.profiles) {
      const list = profileTools.get(p) ?? [];
      list.push(tool.id);
      profileTools.set(p, list);
    }
  }

  const lines: string[] = [];
  const w = (s: string) => lines.push(s);

  w(`; ============================================================================`);
  w(`; profiles.smt2 — Profile Preset Definitions`);
  w(`; ============================================================================`);
  w(`; Encodes the 4 tool profiles from tool-catalog.ts.`);
  w(`; Each profile defines an allow set based on the \`profiles\` field of each`);
  w(`; CoreToolDefinition. "full" has no allow list (everything passes).`);
  w(`;`);
  w(`; Faithful to: tool-catalog.ts (CORE_TOOL_DEFINITIONS, CORE_TOOL_PROFILES)`);
  w(`; ============================================================================`);
  w(``);
  w(`; Requires tools.smt2 to be loaded first.`);
  w(``);

  const emitProfile = (name: string, number: number, toolIds: string[], description: string) => {
    w(`; --------------------------------------------------------------------------`);
    w(`; ${number}. Profile: ${name}`);
    w(`; --------------------------------------------------------------------------`);
    if (name === "full") {
      w(`; No allow list → everything passes. The profile policy is undefined,`);
      w(`; meaning the step is inactive. Modeled as: allow_empty = true.`);
      w(``);
      w(`(define-fun profile_full_allows ((t Tool)) Bool`);
      w(`  true)`);
    } else {
      w(`; Tools with profiles including "${name}":`);
      w(`;   ${toolIds.join(", ")}`);
      w(``);
      w(`(define-fun profile_${name}_allows ((t Tool)) Bool`);
      if (toolIds.length === 0) {
        w(`  false)`);
      } else if (toolIds.length === 1) {
        w(`  (= t ${tc(toolIds[0])}))`);
      } else {
        // Format in rows of ~4
        const rows: string[] = [];
        for (let i = 0; i < toolIds.length; i += 4) {
          const chunk = toolIds.slice(i, i + 4);
          rows.push("      " + chunk.map((id) => `(= t ${tc(id)})`).join(" "));
        }
        w(`  (or ${rows.join("\n").trimStart()}))`);
      }
    }
    w(``);
  };

  emitProfile("minimal", 1, profileTools.get("minimal")!, "");
  emitProfile("coding", 2, profileTools.get("coding")!, "");
  emitProfile("messaging", 3, profileTools.get("messaging")!, "");
  emitProfile("full", 4, [], "");

  // 5. Resolution helper
  w(`; --------------------------------------------------------------------------`);
  w(`; 5. Profile Resolution Helper`);
  w(`; --------------------------------------------------------------------------`);
  w(`; Maps a profile to its allow predicate. In SMT we can't have`);
  w(`; first-class function selection, but we can define a combined predicate.`);
  w(``);
  w(`(declare-const current_profile Int) ; 0=minimal, 1=coding, 2=messaging, 3=full`);
  w(``);
  w(`(define-fun profile_allows ((t Tool)) Bool`);
  w(`  (ite (= current_profile 0) (profile_minimal_allows t)`);
  w(`  (ite (= current_profile 1) (profile_coding_allows t)`);
  w(`  (ite (= current_profile 2) (profile_messaging_allows t)`);
  w(`       true)))) ; 3 or anything else = full`);
  w(``);

  // 6. Active step
  w(`; --------------------------------------------------------------------------`);
  w(`; 6. Profile Produces Active Step?`);
  w(`; --------------------------------------------------------------------------`);
  w(`; "full" produces no policy (step inactive). Others produce allow-only policy.`);
  w(``);
  w(`(define-fun profile_step_active () Bool`);
  w(`  (not (= current_profile 3)))`);
  w(``);
  w(`(define-fun profile_step_allow_empty () Bool`);
  w(`  (= current_profile 3))`);
  w(``);

  // Smoke tests
  w(`; --------------------------------------------------------------------------`);
  w(`; Smoke test: minimal allows session_status`);
  w(`; --------------------------------------------------------------------------`);
  w(`(push 1)`);
  w(`(assert (not (profile_minimal_allows session_status_)))`);
  w(`(check-sat) ; Expected: unsat`);
  w(`(pop 1)`);
  w(``);
  w(`; Smoke test: coding does NOT allow browser`);
  w(`(push 1)`);
  w(`(assert (profile_coding_allows browser_))`);
  w(`(check-sat) ; Expected: unsat`);
  w(`(pop 1)`);
  w(``);
  w(`; Smoke test: messaging allows message`);
  w(`(push 1)`);
  w(`(assert (not (profile_messaging_allows message_)))`);
  w(`(check-sat) ; Expected: unsat`);
  w(`(pop 1)`);
  w(``);
  w(`; Smoke test: minimal ⊂ coding (everything minimal allows, coding also allows)`);
  w(`(push 1)`);
  w(`(declare-const t Tool)`);
  w(`(assert (profile_minimal_allows t))`);
  w(`(assert (not (profile_coding_allows t)))`);
  w(`(check-sat) ; Expected: unsat (minimal is a subset of coding)`);
  w(`(pop 1)`);
  w(``);
  w(`(echo "profiles.smt2 loaded successfully")`);

  return lines.join("\n") + "\n";
}
