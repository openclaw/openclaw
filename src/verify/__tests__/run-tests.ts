#!/usr/bin/env tsx
/**
 * Standalone test runner (no vitest dependency needed).
 */

import * as path from "path";
import { parsePipeline } from "../parse-pipeline.js";
import { parsePolicies } from "../parse-policies.js";
import { parseToolCatalog } from "../parse-tools.js";

const srcDir = path.resolve(import.meta.dirname ?? __dirname, "../../..");
let pass = 0;
let fail = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

console.log("parseToolCatalog:");
const catalog = parseToolCatalog(path.join(srcDir, "src"));
assert(catalog.tools.length === 25, "parses 25 tool definitions");
const ids = new Set(catalog.tools.map((t) => t.id));
assert(ids.has("read") && ids.has("exec") && ids.has("tts"), "has expected tool ids");
assert(catalog.tools.find((t) => t.id === "read")?.sectionId === "fs", "read in fs section");
assert(eq(catalog.tools.find((t) => t.id === "exec")?.profiles, ["coding"]), "exec profiles");
assert(
  catalog.tools.find((t) => t.id === "read")?.includeInOpenClawGroup === false,
  "read not in openclaw",
);
assert(
  catalog.tools.find((t) => t.id === "browser")?.includeInOpenClawGroup === true,
  "browser in openclaw",
);
assert(catalog.sectionOrder[0].id === "fs", "first section is fs");

console.log("\nparsePolicies:");
const policies = parsePolicies(path.join(srcDir, "src"));
assert(
  eq(policies.aliases, { bash: "exec", "apply-patch": "apply_patch" }),
  "2 aliases parsed correctly",
);
assert(policies.ownerOnlyFallbacks.includes("gateway"), "gateway is owner-only");
assert(policies.ownerOnlyFallbacks.includes("cron"), "cron is owner-only");
assert(policies.ownerOnlyFallbacks.includes("whatsapp_login"), "whatsapp_login is owner-only");
assert(policies.subagentDenyAlways.length === 8, "8 subagent deny-always tools");
assert(policies.subagentDenyAlways.includes("gateway"), "gateway in deny-always list");
assert(policies.subagentDenyAlways.includes("memory_get"), "memory_get in deny-always list");
assert(policies.subagentDenyLeaf.length === 3, "3 subagent deny-leaf tools");
assert(policies.subagentDenyLeaf.includes("sessions_spawn"), "sessions_spawn in deny-leaf list");

console.log("\nparsePipeline:");
const pipeline = parsePipeline(path.join(srcDir, "src"));
assert(pipeline.steps.length === 7, "7 pipeline steps");
assert(
  pipeline.steps.every((s) => s.stripPluginOnlyAllowlist),
  "all steps strip plugin-only",
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
