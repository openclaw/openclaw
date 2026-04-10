// Octopus Orchestrator -- `openclaw octo claims list` CLI command (M3-09)
//
// Tabular listing of claims with filters for mission, resource type, and owner arm.
// Follows the gather + format + formatJson + run pattern from status.ts.
//
// Architecture:
//   gatherClaimsList      -- queries the registry with filters, returns ClaimRecord[]
//   formatClaimsList      -- renders human-readable table
//   formatClaimsListJson  -- renders JSON array
//   runClaimsList         -- composes gather + format, writes to output, returns exit code
//
// Boundary discipline (OCTO-DEC-033):
//   Only imports from `node:*` builtins and relative paths inside `src/octo/`.

import type { ClaimFilter, ClaimRecord, RegistryService } from "../head/registry.ts";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface ClaimsListOptions {
  mission?: string;
  resource_type?: string;
  arm?: string;
  json?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Gather -- pure data extraction from the registry
// ──────────────────────────────────────────────────────────────────────────

/** Gathers claim records from the registry, applying optional filters. */
export function gatherClaimsList(
  registry: RegistryService,
  opts: ClaimsListOptions,
): ClaimRecord[] {
  const filter: ClaimFilter = {};
  if (opts.mission !== undefined) {
    filter.mission_id = opts.mission;
  }
  if (opts.resource_type !== undefined) {
    filter.resource_type = opts.resource_type;
  }
  if (opts.arm !== undefined) {
    filter.owner_arm_id = opts.arm;
  }
  return registry.listClaims(filter);
}

// ──────────────────────────────────────────────────────────────────────────
// Format -- human-readable table
// ──────────────────────────────────────────────────────────────────────────

/** Formats claim records for human display as a table. */
export function formatClaimsList(claims: ClaimRecord[]): string {
  const lines: string[] = [];

  if (claims.length === 0) {
    lines.push("No claims found.");
    lines.push("");
    return lines.join("\n");
  }

  lines.push(
    `${"CLAIM_ID".padEnd(20)} ${"RESOURCE_TYPE".padEnd(16)} ${"RESOURCE_KEY".padEnd(24)} ${"MODE".padEnd(14)} ${"OWNER_ARM".padEnd(20)} MISSION`,
  );
  lines.push("-".repeat(120));

  for (const c of claims) {
    lines.push(
      `${c.claim_id.padEnd(20)} ${c.resource_type.padEnd(16)} ${c.resource_key.padEnd(24)} ${c.mode.padEnd(14)} ${c.owner_arm_id.padEnd(20)} ${c.mission_id ?? "-"}`,
    );
  }

  lines.push("");
  lines.push(`${claims.length} claim(s) total`);
  lines.push("");

  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// Format -- JSON
// ──────────────────────────────────────────────────────────────────────────

/** Formats claim records as JSON. */
export function formatClaimsListJson(claims: ClaimRecord[]): string {
  return JSON.stringify(claims, null, 2) + "\n";
}

// ──────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────

/** Entry point for claims list. Returns exit code (0 = success). */
export function runClaimsList(
  registry: RegistryService,
  opts: ClaimsListOptions,
  out: { write: (s: string) => void } = process.stdout,
): number {
  const claims = gatherClaimsList(registry, opts);
  const output = opts.json ? formatClaimsListJson(claims) : formatClaimsList(claims);
  out.write(output);
  return 0;
}
