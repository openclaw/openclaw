import fs from "node:fs";
import {
  loadExecApprovals,
  resolveExecApprovalsPath,
  saveExecApprovals,
} from "../infra/exec-approvals.js";
import { note } from "../terminal/note.js";

/**
 * Detect agents in exec-approvals.json that still use the legacy array allowlist format
 * (before per-host map support was added). Optionally migrate them to `{ "default": [...] }`.
 */
export function migrateExecApprovalsLegacyAllowlist(params?: { shouldRepair?: boolean }): {
  legacyAgents: string[];
  migrated: boolean;
} {
  const filePath = resolveExecApprovalsPath();
  if (!fs.existsSync(filePath)) {
    return { legacyAgents: [], migrated: false };
  }

  let file;
  try {
    file = loadExecApprovals();
  } catch {
    return { legacyAgents: [], migrated: false };
  }

  const agents = file.agents ?? {};
  const legacyAgents: string[] = [];

  for (const [key, agent] of Object.entries(agents)) {
    if (Array.isArray(agent.allowlist)) {
      legacyAgents.push(key);
    }
  }

  if (legacyAgents.length === 0) {
    return { legacyAgents: [], migrated: false };
  }

  if (!params?.shouldRepair) {
    return { legacyAgents, migrated: false };
  }

  // Migrate: convert array → { "default": [...] }
  const migratedAgents = { ...agents };
  for (const key of legacyAgents) {
    const agent = migratedAgents[key];
    if (Array.isArray(agent.allowlist)) {
      migratedAgents[key] = { ...agent, allowlist: { default: agent.allowlist } };
    }
  }

  saveExecApprovals({ ...file, agents: migratedAgents });
  return { legacyAgents, migrated: true };
}

export function noteExecApprovalsHealth(params?: { shouldRepair?: boolean }) {
  const shouldRepair = params?.shouldRepair === true;
  const result = migrateExecApprovalsLegacyAllowlist({ shouldRepair });

  if (result.legacyAgents.length === 0) {
    return;
  }

  const agentList = result.legacyAgents.map((id) => `  - ${id}`).join("\n");
  if (result.migrated) {
    note(
      [
        `Migrated ${result.legacyAgents.length} agent(s) from legacy array allowlist format to per-host map format:`,
        agentList,
        'Allowlists moved to the "default" key — all hosts still allowed.',
      ].join("\n"),
      "exec-approvals migration",
    );
  } else {
    note(
      [
        `${result.legacyAgents.length} agent(s) use the legacy array allowlist format in exec-approvals.json:`,
        agentList,
        'Run "openclaw doctor --fix" to migrate them to the new per-host map format.',
      ].join("\n"),
      "exec-approvals migration",
    );
  }
}
