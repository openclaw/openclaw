import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { formatAge, parsePairingList } from "./format.js";
import { getNodesTheme, runNodesCommand } from "./cli-utils.js";
import { callGatewayCli, nodesCallOpts, resolveNodeId } from "./rpc.js";
import type { NodesRpcOpts } from "./types.js";
import { renderTable } from "../../terminal/table.js";

export function registerNodesPairingCommands(nodes: Command) {
  nodesCallOpts(
    nodes
      .command("pending")
      .description("List pending pairing requests")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("pending", async () => {
          const result = (await callGatewayCli("node.pair.list", opts, {})) as unknown;
          const { pending } = parsePairingList(result);
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(pending, null, 2));
            return;
          }
          if (pending.length === 0) {
            const { muted } = getNodesTheme();
            defaultRuntime.log(muted("No pending pairing requests."));
            return;
          }
          const { heading, warn, muted } = getNodesTheme();
          const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
          const now = Date.now();
          const rows = pending.map((r) => ({
            Request: r.requestId,
            Node: r.displayName?.trim() ? r.displayName.trim() : r.nodeId,
            IP: r.remoteIp ?? "",
            Requested:
              typeof r.ts === "number"
                ? `${formatAge(Math.max(0, now - r.ts))} ago`
                : muted("unknown"),
            Repair: r.isRepair ? warn("yes") : "",
          }));
          defaultRuntime.log(heading("Pending"));
          defaultRuntime.log(
            renderTable({
              width: tableWidth,
              columns: [
                { key: "Request", header: "Request", minWidth: 8 },
                { key: "Node", header: "Node", minWidth: 14, flex: true },
                { key: "IP", header: "IP", minWidth: 10 },
                { key: "Requested", header: "Requested", minWidth: 12 },
                { key: "Repair", header: "Repair", minWidth: 6 },
              ],
              rows,
            }).trimEnd(),
          );
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
          const result = await callGatewayCli("node.pair.approve", opts, {
            requestId,
          });
          defaultRuntime.log(JSON.stringify(result, null, 2));
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
          defaultRuntime.log(JSON.stringify(result, null, 2));
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
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          const name = String(opts.name ?? "").trim();
          if (!nodeId || !name) {
            defaultRuntime.error("--node and --name required");
            defaultRuntime.exit(1);
            return;
          }
          const result = await callGatewayCli("node.rename", opts, {
            nodeId,
            displayName: name,
          });
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          const { ok } = getNodesTheme();
          defaultRuntime.log(ok(`node rename ok: ${nodeId} -> ${name}`));
        });
      }),
  );
}
