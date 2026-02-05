import type { Command } from "commander";
import { defaultRuntime } from "../runtime.js";
import { isRich, theme } from "../terminal/theme.js";
import { renderTable } from "../terminal/table.js";
import { callGatewayFromCli } from "./gateway-rpc.js";
import { describeUnknownError } from "./gateway-cli/shared.js";
import {
  AgentShieldApprovalStore,
  type ApprovalRequestStatus,
} from "../infra/agentshield-approval-store.js";
import { AgentShieldAllowlist } from "../infra/agentshield-allowlist.js";
import { resolveStateDir } from "../config/paths.js";

type AgentShieldApprovalsCliOpts = {
  json?: boolean;
  status?: string;
  limit?: string;
  reason?: string;
};

function isEnabled(): boolean {
  return process.env.AGENTSHIELD_APPROVALS_ENABLED === "1";
}

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
  if (h < 24) {
    return `${h}h`;
  }
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function formatTimestamp(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString();
}

function formatCliError(err: unknown): string {
  const msg = describeUnknownError(err);
  return msg.includes("\n") ? msg.split("\n")[0]! : msg;
}

function checkEnabled(): boolean {
  if (!isEnabled()) {
    defaultRuntime.error(
      "AgentShield approvals are disabled. Set AGENTSHIELD_APPROVALS_ENABLED=1 to enable.",
    );
    defaultRuntime.exit(1);
    return false;
  }
  return true;
}

export function registerAgentShieldApprovalsCli(program: Command) {
  const approvals = program
    .command("agentshield-approvals")
    .alias("as-approvals")
    .description("Manage AgentShield tool-call approvals");

  // ─────────────────────────────────────────────────────────────────────────────
  // LIST command
  // ─────────────────────────────────────────────────────────────────────────────
  approvals
    .command("list")
    .description("List AgentShield approvals")
    .option("--status <status>", "Filter by status (pending|approved|denied|expired)")
    .option("--limit <n>", "Limit number of results")
    .option("--json", "Output as JSON")
    .action(async (opts: AgentShieldApprovalsCliOpts) => {
      if (!checkEnabled()) return;

      try {
        const stateDir = resolveStateDir();
        const store = new AgentShieldApprovalStore(stateDir);

        const statusFilter = opts.status as ApprovalRequestStatus | undefined;
        const limit = opts.limit ? parseInt(opts.limit, 10) : undefined;

        // Get persisted approvals from disk
        const persistedRequests = store.listRequests({ status: statusFilter, limit });

        // Also get in-memory pending approvals from gateway
        let gatewayPending: Array<{
          id: string;
          toolName: string;
          argsFingerprint: string;
          agentId: string;
          createdAtMs: number;
          expiresAtMs: number;
        }> = [];

        try {
          const result = (await callGatewayFromCli("agentshield.approval.list", {}, {})) as {
            entries: typeof gatewayPending;
          };
          gatewayPending = result.entries ?? [];
        } catch {
          // Gateway may not be running; continue with persisted data
        }

        // Merge: gateway pending approvals take precedence for status
        const mergedMap = new Map<string, typeof persistedRequests[0]>();
        for (const req of persistedRequests) {
          mergedMap.set(req.id, req);
        }
        for (const gw of gatewayPending) {
          if (!mergedMap.has(gw.id)) {
            mergedMap.set(gw.id, {
              id: gw.id,
              toolName: gw.toolName,
              argsFingerprint: gw.argsFingerprint,
              agentId: gw.agentId,
              sessionKey: "",
              createdAt: new Date(gw.createdAtMs).toISOString(),
              expiresAt: new Date(gw.expiresAtMs).toISOString(),
              status: "pending",
            });
          }
        }

        let entries = Array.from(mergedMap.values());

        // Apply status filter
        if (statusFilter) {
          entries = entries.filter((e) => e.status === statusFilter);
        }

        // Sort by createdAt descending
        entries.sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );

        // Apply limit
        if (limit && limit > 0) {
          entries = entries.slice(0, limit);
        }

        if (opts.json) {
          defaultRuntime.log(JSON.stringify({ entries }));
          return;
        }

        if (entries.length === 0) {
          defaultRuntime.log(
            isRich()
              ? theme.muted("No approvals found.")
              : "No approvals found.",
          );
          return;
        }

        const now = Date.now();
        const heading = isRich() ? theme.heading : (s: string) => s;
        defaultRuntime.log(heading("AgentShield Approvals"));
        defaultRuntime.log(
          renderTable({
            width: Math.max(80, (process.stdout.columns ?? 120) - 1),
            columns: [
              { key: "ID", header: "ID", minWidth: 12 },
              { key: "Tool", header: "Tool", minWidth: 12, flex: true },
              { key: "Agent", header: "Agent", minWidth: 8 },
              { key: "Status", header: "Status", minWidth: 8 },
              { key: "Age", header: "Age", minWidth: 6 },
            ],
            rows: entries.map((e) => ({
              ID: e.id.slice(0, 12),
              Tool: e.toolName,
              Agent: e.agentId || "*",
              Status: e.status,
              Age: formatAge(now - new Date(e.createdAt).getTime()),
            })),
          }).trimEnd(),
        );
      } catch (err) {
        defaultRuntime.error(formatCliError(err));
        defaultRuntime.exit(1);
      }
    });

  // ─────────────────────────────────────────────────────────────────────────────
  // VIEW command
  // ─────────────────────────────────────────────────────────────────────────────
  approvals
    .command("view <id>")
    .description("View details of an approval request")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: AgentShieldApprovalsCliOpts) => {
      if (!checkEnabled()) return;

      try {
        const stateDir = resolveStateDir();
        const store = new AgentShieldApprovalStore(stateDir);

        const request = store.loadRequest(id.trim());
        const decision = store.loadDecision(id.trim());

        if (!request) {
          // Try to find in gateway
          try {
            const result = (await callGatewayFromCli("agentshield.approval.list", {}, {})) as {
              entries: Array<{
                id: string;
                toolName: string;
                argsFingerprint: string;
                agentId: string;
                createdAtMs: number;
                expiresAtMs: number;
              }>;
            };
            const entry = result.entries?.find(
              (e) => e.id === id.trim() || e.id.startsWith(id.trim()),
            );
            if (entry) {
              if (opts.json) {
                defaultRuntime.log(JSON.stringify(entry));
                return;
              }
              defaultRuntime.log(`ID:          ${entry.id}`);
              defaultRuntime.log(`Tool:        ${entry.toolName}`);
              defaultRuntime.log(`Agent:       ${entry.agentId || "*"}`);
              defaultRuntime.log(`Fingerprint: ${entry.argsFingerprint}`);
              defaultRuntime.log(`Created:     ${formatTimestamp(new Date(entry.createdAtMs).toISOString())}`);
              defaultRuntime.log(`Expires:     ${formatTimestamp(new Date(entry.expiresAtMs).toISOString())}`);
              defaultRuntime.log(`Status:      pending`);
              defaultRuntime.log("");
              defaultRuntime.log(
                isRich()
                  ? theme.muted("Commands:")
                  : "Commands:",
              );
              defaultRuntime.log(`  openclaw agentshield-approvals decide ${entry.id.slice(0, 12)} --decision allow-once`);
              defaultRuntime.log(`  openclaw agentshield-approvals decide ${entry.id.slice(0, 12)} --decision allow-always`);
              defaultRuntime.log(`  openclaw agentshield-approvals decide ${entry.id.slice(0, 12)} --decision deny`);
              return;
            }
          } catch {
            // Gateway not available
          }
          defaultRuntime.error(`Approval not found: ${id}`);
          defaultRuntime.exit(1);
          return;
        }

        if (opts.json) {
          defaultRuntime.log(JSON.stringify({ request, decision }));
          return;
        }

        defaultRuntime.log(`ID:          ${request.id}`);
        defaultRuntime.log(`Tool:        ${request.toolName}`);
        defaultRuntime.log(`Agent:       ${request.agentId || "*"}`);
        defaultRuntime.log(`Session:     ${request.sessionKey || "-"}`);
        defaultRuntime.log(`Fingerprint: ${request.argsFingerprint}`);
        if (request.argsSummary) {
          defaultRuntime.log(`Args:        ${request.argsSummary}`);
        }
        defaultRuntime.log(`Created:     ${formatTimestamp(request.createdAt)}`);
        defaultRuntime.log(`Expires:     ${formatTimestamp(request.expiresAt)}`);
        defaultRuntime.log(`Status:      ${request.status}`);

        if (decision) {
          defaultRuntime.log("");
          defaultRuntime.log(`Decision:    ${decision.decision}`);
          if (decision.reason) {
            defaultRuntime.log(`Reason:      ${decision.reason}`);
          }
          if (decision.resolvedBy) {
            defaultRuntime.log(`Resolved by: ${decision.resolvedBy}`);
          }
          defaultRuntime.log(`Resolved at: ${formatTimestamp(decision.resolvedAt)}`);
        }

        if (request.status === "pending") {
          defaultRuntime.log("");
          defaultRuntime.log(
            isRich()
              ? theme.muted("Commands:")
              : "Commands:",
          );
          defaultRuntime.log(`  openclaw agentshield-approvals decide ${request.id.slice(0, 12)} --decision allow-once`);
          defaultRuntime.log(`  openclaw agentshield-approvals decide ${request.id.slice(0, 12)} --decision allow-always`);
          defaultRuntime.log(`  openclaw agentshield-approvals decide ${request.id.slice(0, 12)} --decision deny`);
        } else if (request.status === "approved" && decision?.decision !== "deny") {
          defaultRuntime.log("");
          defaultRuntime.log(
            isRich()
              ? theme.muted("To retry:")
              : "To retry:",
          );
          defaultRuntime.log(`  openclaw agentshield-approvals retry ${request.id.slice(0, 12)}`);
        }
      } catch (err) {
        defaultRuntime.error(formatCliError(err));
        defaultRuntime.exit(1);
      }
    });

  // ─────────────────────────────────────────────────────────────────────────────
  // DECIDE command (replaces approve)
  // ─────────────────────────────────────────────────────────────────────────────
  approvals
    .command("decide <id>")
    .description("Approve or deny an AgentShield approval (--decision allow-once|allow-always|deny)")
    .requiredOption("--decision <decision>", "Decision: allow-once, allow-always, or deny")
    .option("--reason <reason>", "Optional reason for the decision")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: AgentShieldApprovalsCliOpts & { decision: string }) => {
      if (!checkEnabled()) return;

      try {
        const decision = opts.decision;
        if (!["allow-once", "allow-always", "deny"].includes(decision)) {
          defaultRuntime.error(
            `Invalid decision "${decision}". Use: allow-once, allow-always, or deny.`,
          );
          defaultRuntime.exit(1);
          return;
        }

        const stateDir = resolveStateDir();
        const store = new AgentShieldApprovalStore(stateDir);
        const allowlist = new AgentShieldAllowlist(stateDir);

        // Try to resolve in gateway first
        let gatewayResolved = false;
        try {
          const result = (await callGatewayFromCli("agentshield.approval.resolve", {}, {
            id: id.trim(),
            decision,
          })) as { ok: boolean };
          gatewayResolved = result.ok;
        } catch {
          // Gateway not running or approval not in memory
        }

        // Load request from store to get fingerprint
        const request = store.loadRequest(id.trim());

        // Store decision on disk
        const decisionRecord = {
          id: id.trim(),
          decision: decision as "allow-once" | "allow-always" | "deny",
          reason: opts.reason,
          resolvedBy: process.env.USER ?? "cli",
          resolvedAt: new Date().toISOString(),
        };
        store.storeDecision(decisionRecord);

        // If allow-always, add to allowlist
        if (decision === "allow-always" && request) {
          allowlist.add({
            fingerprint: request.argsFingerprint,
            toolName: request.toolName,
            createdAt: new Date().toISOString(),
            notes: opts.reason,
            approvalId: id.trim(),
          });
        }

        if (opts.json) {
          defaultRuntime.log(JSON.stringify({ ok: true, gatewayResolved, decision }));
          return;
        }

        const emoji = decision === "deny" ? "❌" : "✅";
        defaultRuntime.log(`${emoji} Resolved ${id} → ${decision}`);

        if (decision === "allow-always" && request) {
          defaultRuntime.log(
            isRich()
              ? theme.muted(`Added fingerprint ${request.argsFingerprint.slice(0, 16)}… to allowlist.`)
              : `Added fingerprint ${request.argsFingerprint.slice(0, 16)}… to allowlist.`,
          );
        }

        if (decision !== "deny") {
          defaultRuntime.log("");
          defaultRuntime.log(
            isRich()
              ? theme.muted("To retry the tool call:")
              : "To retry the tool call:",
          );
          defaultRuntime.log(`  openclaw agentshield-approvals retry ${id.slice(0, 12)}`);
        }
      } catch (err) {
        defaultRuntime.error(formatCliError(err));
        defaultRuntime.exit(1);
      }
    });

  // Keep old 'approve' as alias for backwards compatibility
  approvals
    .command("approve <id> <decision>")
    .description("(Deprecated: use 'decide' instead) Approve or deny a pending approval")
    .option("--json", "Output as JSON")
    .action(async (id: string, decision: string, opts: AgentShieldApprovalsCliOpts) => {
      if (!checkEnabled()) return;

      // Delegate to decide
      defaultRuntime.log(
        isRich()
          ? theme.muted("Note: 'approve' is deprecated. Use 'decide --decision <decision>' instead.")
          : "Note: 'approve' is deprecated. Use 'decide --decision <decision>' instead.",
      );

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

  // ─────────────────────────────────────────────────────────────────────────────
  // RETRY command
  // ─────────────────────────────────────────────────────────────────────────────
  approvals
    .command("retry <id>")
    .description("Retry an approved tool call")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: AgentShieldApprovalsCliOpts) => {
      if (!checkEnabled()) return;

      try {
        const stateDir = resolveStateDir();
        const store = new AgentShieldApprovalStore(stateDir);

        const request = store.loadRequest(id.trim());
        const decision = store.loadDecision(id.trim());

        if (!request) {
          defaultRuntime.error(`Approval not found: ${id}`);
          defaultRuntime.exit(1);
          return;
        }

        if (!decision) {
          defaultRuntime.error(`No decision recorded for ${id}. Use 'decide' first.`);
          defaultRuntime.exit(1);
          return;
        }

        if (decision.decision === "deny") {
          defaultRuntime.error(`Cannot retry denied approval ${id}.`);
          defaultRuntime.exit(1);
          return;
        }

        // Try to load from retry store and trigger re-execution
        const { AgentShieldRetryStore } = await import("../infra/agentshield-retry-store.js");
        const retryStore = new AgentShieldRetryStore(stateDir);

        let retryEntry;
        try {
          retryEntry = retryStore.load(id.trim());
        } catch {
          // Retry data not available
        }

        if (!retryEntry) {
          if (opts.json) {
            defaultRuntime.log(JSON.stringify({
              ok: false,
              error: "retry_data_not_available",
              message: "Retry data not available. The tool call must be re-initiated by the agent.",
            }));
            return;
          }
          defaultRuntime.log(
            isRich()
              ? theme.warning("Retry data not available.")
              : "⚠️ Retry data not available.",
          );
          defaultRuntime.log("The tool call must be re-initiated by the agent.");
          defaultRuntime.log("");
          defaultRuntime.log(`Approval ID:  ${request.id}`);
          defaultRuntime.log(`Tool:         ${request.toolName}`);
          defaultRuntime.log(`Fingerprint:  ${request.argsFingerprint}`);
          defaultRuntime.log(`Decision:     ${decision.decision}`);
          return;
        }

        // Consume allow-once after successful retrieval
        if (decision.decision === "allow-once") {
          // Mark as consumed by updating the decision
          store.storeDecision({
            ...decision,
            resolvedAt: new Date().toISOString(),
          });
          // Note: The actual tool execution happens in the gateway handler
          // when it receives the retry. The retry store entry is removed
          // after successful execution.
        }

        if (opts.json) {
          defaultRuntime.log(JSON.stringify({
            ok: true,
            id: request.id,
            toolName: retryEntry.toolName,
            fingerprint: request.argsFingerprint,
            decision: decision.decision,
          }));
          return;
        }

        defaultRuntime.log(`✅ Retry data available for ${id}`);
        defaultRuntime.log(`Tool:        ${retryEntry.toolName}`);
        defaultRuntime.log(`Fingerprint: ${request.argsFingerprint}`);
        defaultRuntime.log(`Decision:    ${decision.decision}`);
        defaultRuntime.log("");
        defaultRuntime.log(
          isRich()
            ? theme.muted("The tool will be re-executed when the agent resumes.")
            : "The tool will be re-executed when the agent resumes.",
        );
      } catch (err) {
        defaultRuntime.error(formatCliError(err));
        defaultRuntime.exit(1);
      }
    });

  // ─────────────────────────────────────────────────────────────────────────────
  // ALLOWLIST commands
  // ─────────────────────────────────────────────────────────────────────────────
  const allowlistCmd = approvals
    .command("allowlist")
    .description("Manage the AgentShield allowlist");

  allowlistCmd
    .command("list")
    .description("List allowlist entries")
    .option("--json", "Output as JSON")
    .action((opts: AgentShieldApprovalsCliOpts) => {
      if (!checkEnabled()) return;

      const stateDir = resolveStateDir();
      const allowlist = new AgentShieldAllowlist(stateDir);
      const entries = allowlist.list();

      if (opts.json) {
        defaultRuntime.log(JSON.stringify({ entries }));
        return;
      }

      if (entries.length === 0) {
        defaultRuntime.log(
          isRich()
            ? theme.muted("Allowlist is empty.")
            : "Allowlist is empty.",
        );
        return;
      }

      const heading = isRich() ? theme.heading : (s: string) => s;
      defaultRuntime.log(heading("AgentShield Allowlist"));
      defaultRuntime.log(
        renderTable({
          width: Math.max(80, (process.stdout.columns ?? 120) - 1),
          columns: [
            { key: "Fingerprint", header: "Fingerprint", minWidth: 20 },
            { key: "Tool", header: "Tool", minWidth: 12, flex: true },
            { key: "Created", header: "Created", minWidth: 12 },
          ],
          rows: entries.map((e) => ({
            Fingerprint: e.fingerprint.slice(0, 16) + "…",
            Tool: e.toolName,
            Created: formatAge(Date.now() - new Date(e.createdAt).getTime()) + " ago",
          })),
        }).trimEnd(),
      );
    });

  allowlistCmd
    .command("remove <fingerprint>")
    .description("Remove a fingerprint from the allowlist")
    .option("--json", "Output as JSON")
    .action((fingerprint: string, opts: AgentShieldApprovalsCliOpts) => {
      if (!checkEnabled()) return;

      const stateDir = resolveStateDir();
      const allowlist = new AgentShieldAllowlist(stateDir);

      // Support partial fingerprint matching
      const entries = allowlist.list();
      const match = entries.find(
        (e) => e.fingerprint === fingerprint || e.fingerprint.startsWith(fingerprint),
      );

      if (!match) {
        if (opts.json) {
          defaultRuntime.log(JSON.stringify({ ok: false, error: "not_found" }));
          return;
        }
        defaultRuntime.error(`Fingerprint not found: ${fingerprint}`);
        defaultRuntime.exit(1);
        return;
      }

      allowlist.remove(match.fingerprint);

      if (opts.json) {
        defaultRuntime.log(JSON.stringify({ ok: true, removed: match.fingerprint }));
        return;
      }

      defaultRuntime.log(`✅ Removed ${match.fingerprint.slice(0, 16)}… from allowlist.`);
    });
}
