/**
 * Generate owner-only.smt2
 */

import type { ParsedAll } from "../types.js";

function tc(id: string): string {
  return `${id}_`;
}

export function emitOwnerOnlySmt2(data: ParsedAll): string {
  const { catalog, policies } = data;
  const ownerOnly = policies.ownerOnlyFallbacks;

  // All tool IDs including whatsapp_login
  const allToolIds = catalog.tools.map((t) => t.id);
  if (!allToolIds.includes("whatsapp_login")) {
    allToolIds.push("whatsapp_login");
  }

  const lines: string[] = [];
  const w = (s: string) => lines.push(s);

  w(`; ============================================================================`);
  w(`; owner-only.smt2 — Owner-Only Pre-Pipeline Filter`);
  w(`; ============================================================================`);
  w(`; Models applyOwnerOnlyToolPolicy from tool-policy.ts.`);
  w(`; This filter runs BEFORE the 7-step pipeline and removes tools that are`);
  w(`; restricted to the owner sender.`);
  w(`;`);
  w(`; Owner-only tools are determined by:`);
  w(
    `;   1. OWNER_ONLY_TOOL_NAME_FALLBACKS: {${JSON.stringify(ownerOnly).slice(1, -1).replace(/"/g, '"')}}`,
  );
  w(`;   2. tool.ownerOnly === true property (runtime, not modeled statically`);
  w(`;      for core tools since none have it set by default — extensible via PLUGIN)`);
  w(`;`);
  w(`; Behavior:`);
  w(`;   - If sender IS owner: all tools pass (but execution is wrapped with guard)`);
  w(`;   - If sender is NOT owner: owner-only tools are filtered OUT entirely`);
  w(`;`);
  w(`; Faithful to: tool-policy.ts (applyOwnerOnlyToolPolicy, isOwnerOnlyTool,`);
  w(`;              OWNER_ONLY_TOOL_NAME_FALLBACKS)`);
  w(`; ============================================================================`);
  w(``);
  w(`; Requires tools.smt2 to be loaded first.`);
  w(``);

  // 1. Owner-only set
  w(`; --------------------------------------------------------------------------`);
  w(`; 1. Owner-Only Tool Set`);
  w(`; --------------------------------------------------------------------------`);
  w(`; Hardcoded in OWNER_ONLY_TOOL_NAME_FALLBACKS:`);
  w(`;   ${ownerOnly.join(", ")}`);
  w(``);
  w(`(define-fun is_owner_only_by_name ((t Tool)) Bool`);
  if (ownerOnly.length === 1) {
    w(`  (= t ${tc(ownerOnly[0])}))`);
  } else {
    w(`  (or ${ownerOnly.map((id) => `(= t ${tc(id)})`).join(" ")}))`);
  }
  w(``);
  w(`; The ownerOnly property on the tool object. For core tools this is not set`);
  w(`; by default. Modeled as a symbolic function for extensibility (plugins`);
  w(`; can set ownerOnly: true).`);
  w(`(declare-fun has_owner_only_property (Tool) Bool)`);
  w(``);
  w(`; Combined: a tool is owner-only if either condition holds`);
  w(`(define-fun is_owner_only ((t Tool)) Bool`);
  w(`  (or (is_owner_only_by_name t)`);
  w(`      (has_owner_only_property t)))`);
  w(``);

  // 2. Sender context
  w(`; --------------------------------------------------------------------------`);
  w(`; 2. Sender Context`);
  w(`; --------------------------------------------------------------------------`);
  w(``);
  w(`(declare-const sender_is_owner Bool)`);
  w(``);

  // 3. Gate
  w(`; --------------------------------------------------------------------------`);
  w(`; 3. Owner-Only Gate`);
  w(`; --------------------------------------------------------------------------`);
  w(`; Pre-pipeline filter: if not owner, remove owner-only tools.`);
  w(`; If owner, all tools pass (they get execution guards but aren't removed).`);
  w(``);
  w(`(define-fun passes_owner_gate ((t Tool)) Bool`);
  w(`  (or sender_is_owner`);
  w(`      (not (is_owner_only t))))`);
  w(``);

  // 4. Effective access (commented out)
  w(`; --------------------------------------------------------------------------`);
  w(`; 4. Effective Access (pipeline + owner gate)`);
  w(`; --------------------------------------------------------------------------`);
  w(`; This combines with pipeline_allows from pipeline.smt2.`);
  w(`; A tool is effectively accessible iff it passes the pipeline AND the`);
  w(`; owner-only gate.`);
  w(`;`);
  w(`; (define-fun effective_allows ((t Tool)) Bool`);
  w(`;   (and (pipeline_allows t) (passes_owner_gate t)))`);
  w(`;`);
  w(`; Uncomment when composing with pipeline.smt2.`);
  w(``);

  // 5. Default properties
  w(`; --------------------------------------------------------------------------`);
  w(`; 5. Default Core Tool Owner-Only Properties`);
  w(`; --------------------------------------------------------------------------`);
  w(`; No core tools have ownerOnly: true by default in the code.`);
  w(`; Only the name-based fallbacks apply.`);
  w(``);
  for (const id of allToolIds) {
    w(`(assert (not (has_owner_only_property ${tc(id)})))`);
  }
  w(``);

  // Smoke tests
  w(`; --------------------------------------------------------------------------`);
  w(`; Smoke test: Non-owner cannot access gateway`);
  w(`; --------------------------------------------------------------------------`);
  w(`(push 1)`);
  w(`(assert (not sender_is_owner))`);
  w(`(assert (passes_owner_gate gateway_))`);
  w(`(check-sat) ; Expected: unsat (gateway is owner-only, non-owner blocked)`);
  w(`(pop 1)`);
  w(``);
  w(`; Smoke test: Owner CAN access gateway`);
  w(`(push 1)`);
  w(`(assert sender_is_owner)`);
  w(`(assert (not (passes_owner_gate gateway_)))`);
  w(`(check-sat) ; Expected: unsat (owner passes everything)`);
  w(`(pop 1)`);
  w(``);
  w(`; Smoke test: Non-owner CAN access exec (not owner-only)`);
  w(`(push 1)`);
  w(`(assert (not sender_is_owner))`);
  w(`(assert (not (passes_owner_gate exec_)))`);
  w(`(check-sat) ; Expected: unsat (exec is not owner-only)`);
  w(`(pop 1)`);
  w(``);
  w(`(echo "owner-only.smt2 loaded successfully")`);

  return lines.join("\n") + "\n";
}
