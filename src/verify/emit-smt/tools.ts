/**
 * Generate tools.smt2 from parsed tool catalog and policy data.
 */

import type { ParsedAll } from "../types.js";

function toolConstructor(id: string): string {
  return `${id}_`;
}

export function emitToolsSmt2(data: ParsedAll): string {
  const { catalog, policies } = data;
  const tools = catalog.tools;
  const sections = catalog.sectionOrder;

  // All core tool constructors + whatsapp_login (special case) + PLUGIN
  const allToolIds = tools.map((t) => t.id);
  // Add whatsapp_login if not already present (it's referenced in owner-only but not in catalog)
  const hasWhatsappLogin = allToolIds.includes("whatsapp_login");
  const extraTools = hasWhatsappLogin ? [] : ["whatsapp_login"];

  // Build section groups
  const sectionGroups = new Map<string, string[]>();
  for (const tool of tools) {
    const list = sectionGroups.get(tool.sectionId) ?? [];
    list.push(tool.id);
    sectionGroups.set(tool.sectionId, list);
  }

  // openclaw group
  const openclawTools = tools.filter((t) => t.includeInOpenClawGroup).map((t) => t.id);

  // Glob helpers
  const webTools = tools.filter((t) => t.id.startsWith("web_")).map((t) => t.id);
  const memoryTools = tools.filter((t) => t.id.startsWith("memory_")).map((t) => t.id);
  const sessionsTools = tools
    .filter((t) => t.id.startsWith("sessions_") || t.id === "session_status")
    .filter((t) => t.id !== "subagents") // subagents doesn't match sessions_*
    .map((t) => t.id);

  const lines: string[] = [];
  const w = (s: string) => lines.push(s);

  w(`; ============================================================================`);
  w(`; tools.smt2 — Tool Universe, Aliases, and Group Definitions`);
  w(`; ============================================================================`);
  w(`; Encodes the ${tools.length} core tools + PLUGIN sentinel as an enumerated SMT datatype.`);
  w(`; Faithful to: tool-catalog.ts, tool-policy-shared.ts`);
  w(`; ============================================================================`);
  w(``);

  // 1. Tool Enumerated Sort
  w(`; --------------------------------------------------------------------------`);
  w(`; 1. Tool Enumerated Sort`);
  w(`; --------------------------------------------------------------------------`);
  w(`; ${tools.length} core tools from CORE_TOOL_DEFINITIONS + PLUGIN sentinel.`);
  if (!hasWhatsappLogin) {
    w(`; Note: whatsapp_login is referenced in owner-only but is not a core tool`);
    w(`; in the catalog — we include it as a special case.`);
  }
  w(``);

  // Format constructors in rows of ~6
  const allConstructors = [...allToolIds, ...extraTools, "PLUGIN"];
  const ctorLines: string[] = [];
  const CHUNK = 6;
  for (let i = 0; i < allConstructors.length; i += CHUNK) {
    const chunk = allConstructors.slice(i, i + CHUNK);
    ctorLines.push(
      "  " +
        chunk.map((id) => (id === "PLUGIN" ? `(${id})` : `(${toolConstructor(id)})`)).join(" "),
    );
  }

  w(`(declare-datatypes ((Tool 0)) ((`);
  for (const line of ctorLines) {
    w(line);
  }
  w(`)))`);
  w(``);

  // 2. Aliases
  w(`; --------------------------------------------------------------------------`);
  w(`; 2. Tool Name Aliases`);
  w(`; --------------------------------------------------------------------------`);
  w(`; From TOOL_NAME_ALIASES in tool-policy-shared.ts:`);
  for (const [alias, target] of Object.entries(policies.aliases)) {
    w(`;   ${alias} → ${target}`);
  }
  w(`;`);
  w(`; Since our sort is closed-world with finite constructors, aliases are`);
  w(`; simply documented here. In concrete config translation, the alias`);
  w(`; resolution happens before encoding (normalizeToolName maps "bash" to`);
  w(`; exec_ and "apply-patch" to apply_patch_ during SMT generation).`);
  w(`;`);
  w(`; For symbolic reasoning, all references use the canonical constructor names.`);
  w(``);

  // 3. Core tool predicate
  w(`; --------------------------------------------------------------------------`);
  w(`; 3. Core Tool Predicate (excludes PLUGIN and non-catalog special cases)`);
  w(`; --------------------------------------------------------------------------`);
  w(``);
  w(`(define-fun is_core_tool ((t Tool)) Bool`);
  // Core scope must match runtime isKnownCoreToolId (catalog only)
  const coreIds = [...allToolIds];
  if (coreIds.length === 0) {
    w(`  false)`);
  } else if (coreIds.length === 1) {
    w(`  (= t ${toolConstructor(coreIds[0])}))`);
  } else {
    // Format in rows
    const rows: string[] = [];
    for (let i = 0; i < coreIds.length; i += 4) {
      const chunk = coreIds.slice(i, i + 4);
      rows.push("      " + chunk.map((id) => `(= t ${toolConstructor(id)})`).join(" "));
    }
    w(`  (or ${rows.join("\n").trimStart()}))`);
  }
  w(``);

  // 4. Section groups
  w(`; --------------------------------------------------------------------------`);
  w(`; 4. Section Groups (from CORE_TOOL_SECTION_ORDER + definitions)`);
  w(`; --------------------------------------------------------------------------`);

  for (const section of sections) {
    const groupTools = sectionGroups.get(section.id) ?? [];
    if (groupTools.length === 0) {
      continue;
    }
    w(`; group:${section.id}`);
    w(`(define-fun in_group_${section.id} ((t Tool)) Bool`);
    if (groupTools.length === 1) {
      w(`  (= t ${toolConstructor(groupTools[0])}))`);
    } else {
      w(`  (or ${groupTools.map((id) => `(= t ${toolConstructor(id)})`).join(" ")}))`);
    }
    w(``);
  }

  // 5. group:openclaw
  w(`; --------------------------------------------------------------------------`);
  w(`; 5. group:openclaw (tools with includeInOpenClawGroup: true)`);
  w(`; --------------------------------------------------------------------------`);
  const nonOpenClaw = tools.filter((t) => !t.includeInOpenClawGroup).map((t) => t.id);
  w(`; From tool-catalog.ts: all tools EXCEPT ${nonOpenClaw.join(", ")}`);
  w(`; (which don't have includeInOpenClawGroup).`);
  w(``);
  w(`(define-fun in_group_openclaw ((t Tool)) Bool`);
  // Format in rows
  const ocLines: string[] = [];
  for (let i = 0; i < openclawTools.length; i += 3) {
    const chunk = openclawTools.slice(i, i + 3);
    ocLines.push("      " + chunk.map((id) => `(= t ${toolConstructor(id)})`).join(" "));
  }
  w(`  (or ${ocLines.join("\n").trimStart()}))`);
  w(``);

  // 6. group:plugins
  w(`; --------------------------------------------------------------------------`);
  w(`; 6. group:plugins — matches the PLUGIN sentinel`);
  w(`; --------------------------------------------------------------------------`);
  w(``);
  w(`(define-fun in_group_plugins ((t Tool)) Bool`);
  w(`  (= t PLUGIN))`);
  w(``);

  // 7. Glob helpers
  w(`; --------------------------------------------------------------------------`);
  w(`; 7. Glob Pattern Helpers`);
  w(`; --------------------------------------------------------------------------`);
  w(`; Since the tool set is finite, globs expand to disjunctions.`);
  w(`; Example: web_* matches web_search_ and web_fetch_`);
  w(`; These are provided as helper predicates for common patterns.`);
  w(``);

  const emitGlobHelper = (name: string, ids: string[]) => {
    w(`(define-fun matches_${name} ((t Tool)) Bool`);
    if (ids.length === 1) {
      w(`  (= t ${toolConstructor(ids[0])}))`);
    } else {
      w(`  (or ${ids.map((id) => `(= t ${toolConstructor(id)})`).join(" ")}))`);
    }
    w(``);
  };

  emitGlobHelper("web_star", webTools);
  emitGlobHelper("memory_star", memoryTools);
  emitGlobHelper("sessions_star", sessionsTools);

  w(`; Note: subagents_ does NOT match sessions_* (different prefix)`);
  w(``);
  w(`; wildcard * matches everything`);
  w(`(define-fun matches_star ((t Tool)) Bool true)`);
  w(``);

  // Smoke tests
  w(`; --------------------------------------------------------------------------`);
  w(`; Smoke test: exec_ is a core tool and is in group:runtime`);
  w(`; --------------------------------------------------------------------------`);
  w(`(push 1)`);
  w(`(assert (not (and (is_core_tool exec_) (in_group_runtime exec_))))`);
  w(`(check-sat) ; Expected: unsat (the assertion is always true)`);
  w(`(pop 1)`);
  w(``);
  w(`; Smoke test 2: PLUGIN is not a core tool`);
  w(`(push 1)`);
  w(`(assert (is_core_tool PLUGIN))`);
  w(`(check-sat) ; Expected: unsat`);
  w(`(pop 1)`);
  w(``);
  w(`(echo "tools.smt2 loaded successfully")`);

  return lines.join("\n") + "\n";
}
