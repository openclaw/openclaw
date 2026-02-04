import type { Command } from "commander";
import { defaultRuntime } from "../runtime.js";
import { isRich, theme } from "../terminal/theme.js";
import { renderTable } from "../terminal/table.js";
import { callGatewayFromCli } from "./gateway-rpc.js";
import { describeUnknownError } from "./gateway-cli/shared.js";

type AgentShieldApprovalsCliOpts = {
  json?: boolean;
};

function formatAge(msAgo: number) {
  const s = Math.max(0, Math.floor(msAgo / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m`;
  }
  const h = Math.floor(m / 60);
  return `${h}h`;
}

function formatCliError(err: unknown): string {
  const msg = describeUnknownError(err);
  return msg.includes("\n") ? msg.split("\n")[0]! : msg;
}

export function registerAgentShieldApprovalsCli(program: Command) {
  const approvals = program
    .command("agentshield-approvals")
    .alias("as-approvals")
    .description("Manage AgentShield tool-call approvals");

  approvals
    .command("list")
    .description("List pending AgentShield approvals")
    .action(async (opts: AgentShieldApprovalsCliOpts) => {
      try {
        const result = (await callGatewayFromCli("agentshield.approval.list", opts, {})) as {
          entries: Array<{
            id: string;
            toolName: string;
            argsFingerprint: string;
            agentId: string;
            createdAtMs: number;
            expiresAtMs: number;
          }>;
        };

        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result));
          return;
        }

        const entries = result.entries ?? [];
        if (entries.length === 0) {
          defaultRuntime.log(isRich() ? theme.muted("No pending approvals.") : "No pending approvals.");
          return;
        }

        const now = Date.now();
        const heading = isRich() ? theme.heading : (s: string) => s;
        defaultRuntime.log(heading("Pending AgentShield Approvals"));
        defaultRuntime.log(
          renderTable({
            width: Math.max(80, (process.stdout.columns ?? 120) - 1),
            columns: [
              { key: "ID", header: "ID", minWidth: 12 },
              { key: "Tool", header: "Tool", minWidth: 12, flex: true },
              { key: "Agent", header: "Agent", minWidth: 8 },
              { key: "Fingerprint", header: "Fingerprint", minWidth: 18 },
              { key: "Expires", header: "Expires", minWidth: 8 },
            ],
            rows: entries.map((e) => ({
              ID: e.id.slice(0, 12),
              Tool: e.toolName,
              Agent: e.agentId || "*",
              Fingerprint: e.argsFingerprint.slice(0, 16) + "…",
              Expires: `${formatAge(Math.max(0, e.expiresAtMs - now))}`,
            })),
          }).trimEnd(),
        );
      } catch (err) {
        defaultRuntime.error(formatCliError(err));
        defaultRuntime.exit(1);
      }
    });

  approvals
    .command("approve <id> <decision>")
    .description("Approve or deny a pending AgentShield approval (allow-once|allow-always|deny)")
    .action(async (id: string, decision: string, opts: AgentShieldApprovalsCliOpts) => {
      try {
        if (!["allow-once", "allow-always", "deny"].includes(decision)) {
          defaultRuntime.error(
            `Invalid decision "${decision}". Use: allow-once, allow-always, or deny.`,
          );
          defaultRuntime.exit(1);
          return;
        }
        const result = (await callGatewayFromCli("agentshield.approval.resolve", opts, {
          id: id.trim(),
          decision,
        })) as { ok: boolean };

        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result));
          return;
        }

        if (result.ok) {
          defaultRuntime.log(`✅ Resolved ${id} → ${decision}`);
        } else {
          defaultRuntime.error(`Failed to resolve ${id}.`);
          defaultRuntime.exit(1);
        }
      } catch (err) {
        defaultRuntime.error(formatCliError(err));
        defaultRuntime.exit(1);
      }
    });

  approvals
    .command("retry <id>")
    .description("Show stored retry data for a pending approval (args fingerprint only)")
    .action(async (id: string, opts: AgentShieldApprovalsCliOpts) => {
      try {
        // Retry data is local to the gateway's state dir — we can only show
        // metadata here.  Actual re-execution happens in the gateway handler
        // when the approval is resolved with allow-once/allow-always.
        const result = (await callGatewayFromCli("agentshield.approval.list", opts, {})) as {
          entries: Array<{
            id: string;
            toolName: string;
            argsFingerprint: string;
            agentId: string;
          }>;
        };

        const entry = result.entries?.find((e) => e.id === id.trim() || e.id.startsWith(id.trim()));
        if (!entry) {
          defaultRuntime.error(`No pending approval found for id: ${id}`);
          defaultRuntime.exit(1);
          return;
        }

        if (opts.json) {
          defaultRuntime.log(JSON.stringify(entry));
          return;
        }

        defaultRuntime.log(`ID:          ${entry.id}`);
        defaultRuntime.log(`Tool:        ${entry.toolName}`);
        defaultRuntime.log(`Agent:       ${entry.agentId || "*"}`);
        defaultRuntime.log(`Fingerprint: ${entry.argsFingerprint}`);
        defaultRuntime.log("");
        defaultRuntime.log(
          isRich()
            ? theme.muted("Use 'agentshield-approvals approve <id> allow-once' to approve and retry.")
            : "Use 'agentshield-approvals approve <id> allow-once' to approve and retry.",
        );
      } catch (err) {
        defaultRuntime.error(formatCliError(err));
        defaultRuntime.exit(1);
      }
    });
}
