// Claw doctor diagnostics project the lifecycle ownership ledger into health findings.
import type { DatabaseSync } from "node:sqlite";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import {
  openExistingOpenClawStateDatabaseReadOnly,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { isExperimentalClawsEnabled } from "./experimental.js";
import { readClawStatus, type ClawStatusRecord } from "./lifecycle-state.js";

const CLAW_STATE_CHECK_ID = "core/doctor/claws-state";

export type ClawDoctorOptions = OpenClawStateDatabaseOptions & {
  cfg?: OpenClawConfig;
  sourceMcpServers?: Record<string, Record<string, unknown>>;
  listMcpServers?: typeof listConfiguredMcpServers;
};

function finding(params: {
  severity?: HealthFinding["severity"];
  message: string;
  path?: string;
  target?: string;
  requirement?: string;
  fixHint?: string;
}): HealthFinding {
  return {
    checkId: CLAW_STATE_CHECK_ID,
    source: "doctor",
    severity: params.severity ?? "warning",
    ...params,
  };
}

function collectInstallFindings(record: ClawStatusRecord): HealthFinding[] {
  const agentId = record.install.agentId;
  const findings: HealthFinding[] = [];
  if (record.install.status === "partial") {
    findings.push(
      finding({
        message: `Claw agent ${JSON.stringify(agentId)} has a partial install record.`,
        path: `claws.${agentId}`,
        target: agentId,
        requirement: "Claw installs should complete or retain explicit partial ownership state",
        fixHint: "Inspect `openclaw claws status` before retrying or removing this Claw.",
      }),
    );
  }
  if (record.agentState !== "present") {
    findings.push(
      finding({
        message:
          record.agentState === "missing"
            ? `Claw-owned agent ${JSON.stringify(agentId)} is missing from config.`
            : `Claw-owned agent ${JSON.stringify(agentId)} changed after installation.`,
        path: `agents.list.${agentId}`,
        target: agentId,
        requirement: "Claw-owned agent config should match its recorded install digest",
        fixHint: "Inspect the agent change before removing or replacing Claw-owned state.",
      }),
    );
  }
  for (const file of record.workspaceFiles) {
    if (file.state === "unchanged") {
      continue;
    }
    findings.push(
      finding({
        message:
          file.state === "missing"
            ? `Claw-managed workspace file is missing: ${file.path}`
            : file.state === "modified"
              ? `Claw-managed workspace file changed after installation: ${file.path}`
              : `Claw-managed workspace file is unsafe to inspect: ${file.path}${file.message ? ` (${file.message})` : ""}`,
        path: `claws.${agentId}.workspace.${file.path}`,
        target: `${file.workspace}:${file.path}`,
        requirement: "Claw-managed workspace files should remain inspectable with recorded content",
        fixHint: "Keep intentional local edits, or inspect the file before removing the Claw.",
      }),
    );
  }
  for (const pkg of record.packages) {
    if (pkg.state === "present") {
      continue;
    }
    findings.push(
      finding({
        message: `Claw ${pkg.kind} ${JSON.stringify(`${pkg.ref}@${pkg.version}`)} has ${pkg.state} lifecycle state.`,
        path: `claws.${agentId}.packages.${pkg.kind}.${pkg.ref}`,
        target: `${pkg.source}:${pkg.ref}@${pkg.version}`,
        requirement: "Claw package references should match canonical installed package state",
        fixHint:
          "Inspect package state with `openclaw claws status` before updating or removing the Claw.",
      }),
    );
  }
  for (const server of record.mcpServers) {
    if (server.state === "present") {
      continue;
    }
    findings.push(
      finding({
        message: `Claw MCP server ${JSON.stringify(server.name)} has ${server.state} ownership state${server.error ? `: ${server.error}` : "."}`,
        path: `mcp.servers.${server.name}`,
        target: server.name,
        requirement: "Claw MCP ownership should be complete and match live canonical config",
        fixHint:
          server.state === "failed"
            ? "Remove the partial Claw to release its non-owning reference."
            : "Inspect MCP config drift before removing or replacing Claw-owned state.",
      }),
    );
  }
  for (const cron of record.cronJobs) {
    if (cron.status === "complete" && cron.schedulerJobId) {
      continue;
    }
    findings.push(
      finding({
        message: `Claw cron declaration ${JSON.stringify(cron.manifestId)} has ${cron.status} ownership state${cron.error ? `: ${cron.error}` : "."}`,
        path: `claws.${agentId}.cronJobs.${cron.manifestId}`,
        target: cron.schedulerJobId ?? cron.declarationKey,
        requirement: "Claw cron ownership should resolve to a persisted scheduler job id",
        fixHint: "Reconcile the declaration with the gateway before removing the Claw.",
      }),
    );
  }
  return findings;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

function orphanedAgentIds(options: OpenClawStateDatabaseOptions): string[] {
  const { db } = openOpenClawStateDatabase(options);
  const installed = new Set<string>();
  if (tableExists(db, "claw_installs")) {
    for (const row of db.prepare("SELECT agent_id FROM claw_installs").all() as Array<{
      agent_id: string;
    }>) {
      installed.add(row.agent_id);
    }
  }
  const referenced = new Set<string>();
  for (const table of [
    "claw_workspace_files",
    "claw_package_refs",
    "claw_mcp_server_refs",
    "claw_cron_refs",
  ]) {
    if (!tableExists(db, table)) {
      continue;
    }
    for (const row of db.prepare(`SELECT DISTINCT agent_id FROM ${table}`).all() as Array<{
      agent_id: string;
    }>) {
      referenced.add(row.agent_id);
    }
  }
  return [...referenced].filter((agentId) => !installed.has(agentId)).toSorted();
}

export async function collectClawStateHealthFindings(
  options: ClawDoctorOptions = {},
): Promise<readonly HealthFinding[]> {
  if (!isExperimentalClawsEnabled(options.env ?? process.env)) {
    return [];
  }
  let database: OpenClawStateDatabase | undefined;
  try {
    database = openExistingOpenClawStateDatabaseReadOnly(options);
    if (!database) {
      return [];
    }
    if (!tableExists(database.db, "claw_installs")) {
      return [];
    }
    let sourceMcpServers = options.sourceMcpServers;
    if (!sourceMcpServers) {
      const listed = await (options.listMcpServers ?? listConfiguredMcpServers)();
      if (!listed.ok) {
        throw new Error(listed.error);
      }
      sourceMcpServers = listed.mcpServers;
    }
    const status = await readClawStatus(undefined, {
      ...options,
      database,
      readOnly: true,
      ...(options.cfg ? { config: options.cfg } : {}),
      sourceMcpServers,
    });
    const findings = status.records.flatMap(collectInstallFindings);
    for (const agentId of orphanedAgentIds({ ...options, database, readOnly: true })) {
      findings.push(
        finding({
          message: `Claw ownership references for agent ${JSON.stringify(agentId)} have no root install record.`,
          path: `claws.${agentId}`,
          target: agentId,
          requirement: "Claw-owned resources should have a matching claw_installs row",
          fixHint:
            "Inspect the state database and live resources before deleting orphaned references.",
        }),
      );
    }
    return findings;
  } catch (error) {
    return [
      finding({
        severity: "error",
        message: `Could not inspect Claw lifecycle state: ${error instanceof Error ? error.message : String(error)}`,
        requirement: "Claw doctor diagnostics require readable lifecycle state",
      }),
    ];
  } finally {
    database?.walMaintenance.close();
  }
}
