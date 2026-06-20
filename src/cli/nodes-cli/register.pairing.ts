// Node pairing commands: list, approve, reject, remove, and rename paired nodes.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { getTerminalTableWidth } from "../../../packages/terminal-core/src/table.js";
import type { OperatorScope } from "../../gateway/method-scopes.js";
import { resolveNodePairApprovalScopes } from "../../infra/node-pairing-authz.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import { getNodesTheme, runNodesCommand } from "./cli-utils.js";
import { parsePairingList } from "./format.js";
import { renderPendingPairingRequestsTable } from "./pairing-render.js";
import {
  callGatewayCli,
  callNodePairApprovalGatewayCli,
  nodesCallOpts,
  resolveNodeId,
} from "./rpc.js";
import type { NodesRpcOpts, PendingRequest } from "./types.js";

const DEFAULT_NODE_PAIR_APPROVE_SCOPES: OperatorScope[] = ["operator.pairing"];
const NODE_PAIR_APPROVE_SCOPE_SET = new Set<OperatorScope>([
  "operator.pairing",
  "operator.write",
  "operator.admin",
]);

function normalizeNodePairApproveScopes(scopes: unknown): OperatorScope[] {
  const normalized = new Set<OperatorScope>(DEFAULT_NODE_PAIR_APPROVE_SCOPES);
  if (!Array.isArray(scopes)) {
    return [...normalized];
  }
  for (const scope of scopes) {
    if (typeof scope !== "string") {
      continue;
    }
    if (!NODE_PAIR_APPROVE_SCOPE_SET.has(scope as OperatorScope)) {
      continue;
    }
    normalized.add(scope as OperatorScope);
  }
  return [...normalized];
}

async function resolveApproveScopesForRequest(
  opts: NodesRpcOpts,
  requestId: string,
): Promise<OperatorScope[]> {
  try {
    const result = await callNodePairApprovalGatewayCli(
      "node.pair.list",
      opts,
      {},
      { scopes: DEFAULT_NODE_PAIR_APPROVE_SCOPES },
    );
    const { pending } = parsePairingList(result);
    const request = pending.find((candidate: PendingRequest) => candidate.requestId === requestId);
    const scopes = normalizeNodePairApproveScopes(request?.requiredApproveScopes);
    if (scopes.length > DEFAULT_NODE_PAIR_APPROVE_SCOPES.length) {
      return scopes;
    }
    // Older pending requests only list requested commands; derive approval scopes from them.
    return resolveNodePairApprovalScopes(request?.commands) as OperatorScope[];
  } catch {
    return [...DEFAULT_NODE_PAIR_APPROVE_SCOPES];
  }
}

function isUnknownNodePairRequestIdError(error: unknown): boolean {
  const requestError = error as (Error & { gatewayCode?: unknown; details?: unknown }) | undefined;
  const details = requestError?.details;
  return (
    requestError instanceof Error &&
    requestError.name === "GatewayClientRequestError" &&
    requestError.gatewayCode === "INVALID_REQUEST" &&
    requestError.message === "unknown requestId" &&
    details === undefined
  );
}

function createNodePairRequestIdMessageError(message: string): Error {
  const error = new Error(message);
  error.name = "NodePairRequestIdMessageError";
  error.toString = () => message;
  return error;
}

async function buildUnknownNodePairRequestIdMessage(
  opts: NodesRpcOpts,
  requestId: string,
): Promise<string> {
  let pendingIds: string[];
  try {
    const result = await callNodePairApprovalGatewayCli(
      "node.pair.list",
      opts,
      {},
      { scopes: DEFAULT_NODE_PAIR_APPROVE_SCOPES },
    );
    pendingIds = parsePairingList(result)
      .pending.map((request: PendingRequest) => request.requestId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    pendingIds = [];
  }
  const lines = [`Unknown node pairing requestId: ${requestId}`];
  if (pendingIds.length > 0) {
    lines.push(`Pending requestIds: ${pendingIds.join(", ")}`);
  } else {
    lines.push("No pending node pairing requests are currently visible.");
  }
  lines.push(`Run ${formatCliCommand("openclaw nodes pending")} to inspect current requests.`);
  return lines.join("\n");
}

/** Register node pairing management commands. */
export function registerNodesPairingCommands(nodes: Command) {
  nodesCallOpts(
    nodes
      .command("pending")
      .description("List pending pairing requests")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("pending", async () => {
          const result = await callGatewayCli("node.pair.list", opts, {});
          const { pending } = parsePairingList(result);
          if (opts.json) {
            defaultRuntime.writeJson(pending);
            return;
          }
          if (pending.length === 0) {
            const { muted } = getNodesTheme();
            defaultRuntime.log(muted("No pending pairing requests."));
            return;
          }
          const { heading, warn, muted } = getNodesTheme();
          const tableWidth = getTerminalTableWidth();
          const now = Date.now();
          const rendered = renderPendingPairingRequestsTable({
            pending,
            now,
            tableWidth,
            theme: { heading, warn, muted },
          });
          defaultRuntime.log(rendered.heading);
          defaultRuntime.log(rendered.table);
        });
      }),
  );

  nodesCallOpts(
    nodes
      .command("approve")
      .description("Approve a pending pairing request")
      .argument("<requestId>", "Pending request id")
      .action(async (requestId: string, opts: NodesRpcOpts) => {
        await runNodesCommand("approve", async () => {
          const scopes = await resolveApproveScopesForRequest(opts, requestId);
          let result: unknown;
          try {
            result = await callNodePairApprovalGatewayCli(
              "node.pair.approve",
              opts,
              {
                requestId,
              },
              {
                scopes,
              },
            );
          } catch (error) {
            if (!isUnknownNodePairRequestIdError(error)) {
              throw error;
            }
            throw createNodePairRequestIdMessageError(
              await buildUnknownNodePairRequestIdMessage(opts, requestId),
            );
          }
          defaultRuntime.writeJson(result);
        });
      }),
  );

  nodesCallOpts(
    nodes
      .command("reject")
      .description("Reject a pending pairing request")
      .argument("<requestId>", "Pending request id")
      .action(async (requestId: string, opts: NodesRpcOpts) => {
        await runNodesCommand("reject", async () => {
          const result = await callGatewayCli("node.pair.reject", opts, {
            requestId,
          });
          defaultRuntime.writeJson(result);
        });
      }),
  );

  nodesCallOpts(
    nodes
      .command("remove")
      .description("Remove a paired node entry")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("remove", async () => {
          const nodeId = await resolveNodeId(opts, normalizeOptionalString(opts.node) ?? "");
          if (!nodeId) {
            defaultRuntime.error(
              `--node is required. Run ${formatCliCommand("openclaw nodes pairing pending")} to choose a node request.`,
            );
            defaultRuntime.exit(1);
            return;
          }
          const result = await callGatewayCli("node.pair.remove", opts, { nodeId });
          if (opts.json) {
            defaultRuntime.writeJson(result);
            return;
          }
          const { warn } = getNodesTheme();
          defaultRuntime.log(warn(`Removed paired node ${nodeId}`));
        });
      }),
  );

  nodesCallOpts(
    nodes
      .command("rename")
      .description("Rename a paired node (display name override)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .requiredOption("--name <displayName>", "New display name")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("rename", async () => {
          const nodeId = await resolveNodeId(opts, normalizeOptionalString(opts.node) ?? "");
          const name = normalizeOptionalString(opts.name) ?? "";
          if (!nodeId || !name) {
            defaultRuntime.error(
              `--node and --name are required. Run ${formatCliCommand("openclaw nodes pairing pending")} to choose a node, then rerun with --name <displayName>.`,
            );
            defaultRuntime.exit(1);
            return;
          }
          const result = await callGatewayCli("node.rename", opts, {
            nodeId,
            displayName: name,
          });
          if (opts.json) {
            defaultRuntime.writeJson(result);
            return;
          }
          const { ok } = getNodesTheme();
          defaultRuntime.log(ok(`node rename ok: ${nodeId} -> ${name}`));
        });
      }),
  );
}
