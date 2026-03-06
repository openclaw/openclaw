/**
 * Generate property files (P1-P6) and supporting files.
 * These are essentially static — they don't depend on parsed data,
 * but we generate them for completeness and to keep everything in one place.
 */

import * as fs from "fs";
import * as path from "path";

export function emitAllSmt2(): string {
  return `; ============================================================================
; all.smt2 — Combined Model (loads all components in dependency order)
; ============================================================================
; Usage: z3 all.smt2
;
; This file includes all model components. Individual files require
; tools.smt2 to be loaded first for the Tool datatype.
; ============================================================================

(set-logic ALL)

; --- 1. Tool Universe ---
(include "tools.smt2")

; --- 2. Owner-Only Gate ---
(include "owner-only.smt2")

; --- 3. Pipeline Semantics ---
(include "pipeline.smt2")

; Link visible core predicate to owner gate semantics (runtime parity)
(assert (forall ((t Tool))
         (= (core_tool_visible t)
            (and (is_core_tool t) (passes_owner_gate t)))))

; --- 4. Profile Presets ---
(include "profiles.smt2")

; --- 5. Subagent Deny Lists ---
(include "subagent.smt2")

(echo "=== All models loaded successfully ===")
`;
}

export function copyPropertyFiles(refDir: string, outputDir: string): void {
  const propsDir = path.join(outputDir, "properties");
  fs.mkdirSync(propsDir, { recursive: true });

  const refPropsDir = path.join(refDir, "properties");
  const files = [
    "p1-dangerous-bypass.smt2",
    "p2-deny-dominance.smt2",
    "p3-stripping-soundness.smt2",
    "p4-subagent-containment.smt2",
    "p5-profile-monotonicity.smt2",
    "p6-owner-only-completeness.smt2",
    "run-all.sh",
  ];

  for (const file of files) {
    const src = path.join(refPropsDir, file);
    const dst = path.join(propsDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      if (file === "run-all.sh") {
        fs.chmodSync(dst, 0o755);
      }
    } else {
      console.warn(`[properties] Warning: reference file not found: ${src}`);
    }
  }
  console.log(`[properties] Copied ${files.length} property files to ${propsDir}`);
}
