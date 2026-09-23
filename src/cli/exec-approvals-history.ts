// `openclaw approvals history`: read-only view over the gateway's rolling
// resolved-approval ledger. Split from exec-approvals-cli.ts so the ledger
// rendering keeps that file from growing past its line-cap ratchet.
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import type { Command } from "commander";
import {
  validateApprovalHistoryResult,
  type ApprovalHistoryResult,
  type ApprovalKind,
  type TerminalApprovalSnapshot,
} from "../../packages/gateway-protocol/src/index.js";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import {
  getTerminalTableWidth,
  renderTerminalSafeTable,
} from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { APPROVALS_SCOPE } from "../gateway/method-scopes.js";
import { defaultRuntime } from "../runtime.js";
import {
  approvalRecordedDecision,
  escapeApprovalTextForTerminal,
  exitWithError,
  failApprovalsCommand,
  formatResolver,
  type ExecApprovalsCliOpts,
} from "./exec-approvals-cli-shared.js";
import { callGatewayFromCli } from "./gateway-rpc.js";
import { nodesCallOpts } from "./nodes-cli/rpc.js";

// Ledger filters mirror ApprovalHistoryParamsSchema so the Gateway validator stays
// authoritative; local parsing only keeps malformed input from making a round trip.
const APPROVAL_HISTORY_KINDS = [
  "exec",
  "plugin",
  "system-agent",
] as const satisfies readonly ApprovalKind[];
const APPROVAL_HISTORY_MAX_LIMIT = 100;
const APPROVAL_HISTORY_RETENTION_NOTE = "Approval history is a rolling 30-day window.";

type ApprovalHistoryCliOpts = ExecApprovalsCliOpts & {
  kind?: string;
  limit?: string;
  cursor?: string;
};

type ApprovalHistoryQuery = {
  kind?: ApprovalKind;
  limit?: number;
  cursor?: string;
};

function isApprovalHistoryKind(value: string): value is ApprovalKind {
  return APPROVAL_HISTORY_KINDS.some((kind) => kind === value);
}

function readApprovalHistoryQuery(opts: ApprovalHistoryCliOpts): ApprovalHistoryQuery {
  const query: ApprovalHistoryQuery = {};
  if (opts.kind !== undefined) {
    if (!isApprovalHistoryKind(opts.kind)) {
      exitWithError(`--kind must be one of: ${APPROVAL_HISTORY_KINDS.join(", ")}.`);
    }
    query.kind = opts.kind;
  }
  if (opts.limit !== undefined) {
    const limit = parseStrictPositiveInteger(opts.limit);
    if (limit === undefined || limit > APPROVAL_HISTORY_MAX_LIMIT) {
      exitWithError(`--limit must be an integer between 1 and ${APPROVAL_HISTORY_MAX_LIMIT}.`);
    }
    query.limit = limit;
  }
  if (opts.cursor !== undefined) {
    if (!opts.cursor.trim()) {
      exitWithError("--cursor must not be empty.");
    }
    // Cursors are opaque signed tokens: forward verbatim so paging never depends on trimming.
    query.cursor = opts.cursor;
  }
  return query;
}

async function loadApprovalHistory(
  opts: ApprovalHistoryCliOpts,
  query: ApprovalHistoryQuery,
): Promise<ApprovalHistoryResult> {
  // approval.history declares operator.approvals; unlike the owner-specific pending
  // lists it needs no admin scope, so request only what the ledger read requires.
  const result = await callGatewayFromCli("approval.history", opts, query, {
    scopes: [APPROVALS_SCOPE],
  });
  if (!validateApprovalHistoryResult(result)) {
    throw new Error("Invalid approval history response.");
  }
  return result;
}

function formatApprovalHistoryRequest(item: TerminalApprovalSnapshot): string {
  const presentation = item.presentation;
  // System-agent rows stay on their reviewer-safe presentation: the exact
  // operation is host-local by contract and must not leak into terminals.
  const text =
    presentation.kind === "exec"
      ? presentation.commandText
      : `${presentation.title}: ${presentation.description}`;
  return escapeApprovalTextForTerminal(text);
}

function formatApprovalHistorySource(item: TerminalApprovalSnapshot): string {
  const parts = [item.source?.agentId, item.source?.sessionKey].filter((value): value is string =>
    Boolean(value),
  );
  return parts.length > 0 ? escapeApprovalTextForTerminal(parts.join(" / ")) : "-";
}

function formatApprovalHistoryDecision(item: TerminalApprovalSnapshot): string {
  // Expired and cancelled rows failed closed without a reviewer decision; the
  // terminal status is the honest answer for an audit trail.
  return approvalRecordedDecision(item) ?? item.status;
}

function formatApprovalHistoryResolvedAt(resolvedAtMs: number): string {
  // Absolute UTC timestamps: an audit trail must not shift with the reader's clock.
  // Second precision keeps the column narrow enough to survive small terminals.
  return new Date(resolvedAtMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Prints the store cursor that continues this listing.
 *
 * Session-access filtering runs after pagination, so a page can come back empty
 * while more retained rows sit behind it. Callers must therefore surface the
 * cursor on every page, or a restricted reviewer's paging dead-ends on the
 * first fully filtered page.
 *
 * The cursor pins position only: the Gateway reapplies `kind`/`limit` from each
 * request, so the printed command must carry the validated filters or following
 * the hint silently broadens the next page. Connection options are not echoed
 * (they can hold credentials); the hint tells the reader to reuse their own.
 */
function logApprovalHistoryCursor(
  nextCursor: string | undefined,
  query: ApprovalHistoryQuery,
): void {
  if (!nextCursor) {
    return;
  }
  const cursor = sanitizeForLog(nextCursor);
  const filters = [
    query.kind ? ` --kind ${query.kind}` : "",
    query.limit !== undefined ? ` --limit ${query.limit}` : "",
  ].join("");
  defaultRuntime.log(theme.muted(`Next cursor: ${cursor}`));
  defaultRuntime.log(
    theme.muted(
      `Page with: openclaw approvals history --cursor ${cursor}${filters} (reuse your original connection options)`,
    ),
  );
}

function renderApprovalHistory(result: ApprovalHistoryResult, query: ApprovalHistoryQuery): void {
  const items = result.items;
  if (items.length === 0) {
    defaultRuntime.log(theme.muted(`No resolved approvals. ${APPROVAL_HISTORY_RETENTION_NOTE}`));
    logApprovalHistoryCursor(result.nextCursor, query);
    return;
  }
  defaultRuntime.log(`${theme.heading("Resolved approvals")} ${theme.muted(`(${items.length})`)}`);
  defaultRuntime.log(
    renderTerminalSafeTable({
      width: getTerminalTableWidth(),
      columns: [
        { key: "Resolved", header: "Resolved", minWidth: 20 },
        { key: "Kind", header: "Kind", minWidth: 12 },
        { key: "Decision", header: "Decision", minWidth: 12 },
        { key: "Reason", header: "Reason", minWidth: 12 },
        { key: "Source", header: "Agent / Session", minWidth: 16, flex: true },
        { key: "Resolver", header: "Resolver", minWidth: 12 },
        { key: "Request", header: "Command / Summary", minWidth: 20, flex: true },
      ],
      rows: items.map((item) => ({
        Resolved: formatApprovalHistoryResolvedAt(item.resolvedAtMs),
        Kind: item.presentation.kind,
        Decision: formatApprovalHistoryDecision(item),
        Reason: item.reason,
        Source: formatApprovalHistorySource(item),
        Resolver: formatResolver(item),
        Request: formatApprovalHistoryRequest(item),
      })),
    }).trimEnd(),
  );
  defaultRuntime.log(theme.muted(APPROVAL_HISTORY_RETENTION_NOTE));
  logApprovalHistoryCursor(result.nextCursor, query);
}

/** Registers `openclaw approvals history` on the approvals command. */
export function registerApprovalsHistoryCommand(approvals: Command): void {
  const historyCmd = approvals
    .command("history")
    .description("List resolved approvals from the rolling 30-day gateway ledger")
    .option("--kind <kind>", "Filter by approval kind (exec, plugin, system-agent)")
    .option("--limit <n>", `Maximum rows to return (1-${APPROVAL_HISTORY_MAX_LIMIT})`)
    .option("--cursor <token>", "Resume from the nextCursor printed by a previous page")
    .action(async (opts: ApprovalHistoryCliOpts) => {
      try {
        const query = readApprovalHistoryQuery(opts);
        const result = await loadApprovalHistory(opts, query);
        if (opts.json) {
          defaultRuntime.writeJson(result, 0);
          return;
        }
        renderApprovalHistory(result, query);
      } catch (err) {
        failApprovalsCommand(err, opts);
      }
    });
  nodesCallOpts(historyCmd);
}
