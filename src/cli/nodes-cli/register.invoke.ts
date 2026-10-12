// Generic node.invoke command with shell-exec commands intentionally blocked.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { runNodesCommand } from "./cli-utils.js";
import {
  buildNodeInvokeParams,
  callNodesGatewayCli,
  nodesCallOpts,
  parseOptionalNodeInteger,
  resolveCliNodeId,
} from "./rpc.js";
import type { NodesRpcOpts } from "./types.js";

const BLOCKED_NODE_INVOKE_COMMANDS = new Set(["system.run", "system.run.prepare"]);

function parseNodeInvokeParams(value = "{}"): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("--params must be valid JSON.");
  }
}

export function registerNodesInvokeCommands(nodes: Command) {
  nodesCallOpts(
    nodes
      .command("invoke")
      .description("Invoke a command on a paired node")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .requiredOption("--command <command>", "Command (e.g. canvas.navigate)")
      .option("--params <json>", "JSON object string for params", "{}")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 15000)", "15000")
      .option("--idempotency-key <key>", "Key to avoid duplicate requests (optional)")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("invoke", async () => {
          const nodeQuery = normalizeOptionalString(opts.node) ?? "";
          const command = normalizeOptionalString(opts.command) ?? "";
          if (!nodeQuery || !command) {
            throw new Error("--node and --command required");
          }
          if (BLOCKED_NODE_INVOKE_COMMANDS.has(command.toLowerCase())) {
            throw new Error(
              `command "${command}" is reserved for shell execution; use the exec tool with host=node instead`,
            );
          }
          const params = parseNodeInvokeParams(opts.params);
          const timeoutMs = parseOptionalNodeInteger(opts.invokeTimeout, "--invoke-timeout");
          if (opts.idempotencyKey === "") {
            throw new Error("--idempotency-key must not be empty.");
          }
          const nodeId = await resolveCliNodeId(opts, nodeQuery);

          const invokeParams = buildNodeInvokeParams({
            nodeId,
            command,
            params,
            idempotencyKey: opts.idempotencyKey,
            timeoutMs,
          });

          const result = await callNodesGatewayCli("node.invoke", opts, invokeParams);
          defaultRuntime.writeJson(result);
        });
      }),
    { timeoutMs: 30_000 },
  );
}
