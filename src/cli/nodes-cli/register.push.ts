import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { getNodesTheme, runNodesCommand } from "./cli-utils.js";
import { callGatewayCli, nodesCallOpts, resolveNodeId } from "./rpc.js";
import type { NodesRpcOpts } from "./types.js";

type NodesPushOpts = NodesRpcOpts & {
  node?: string;
  title?: string;
  body?: string;
  environment?: string;
};

function normalizeEnvironment(value: unknown): "sandbox" | "production" | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "sandbox" || normalized === "production") {
    return normalized;
  }
  return null;
}

export function registerNodesPushCommand(nodes: Command) {
  nodesCallOpts(
    nodes
      .command("push")
      .description("Send an APNs test push to an iOS node")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--title <text>", "Push title", "OpenClaw")
      .option("--body <text>", "Push body")
      .option("--environment <sandbox|production>", "Override APNs environment")
      .action(async (opts: NodesPushOpts) => {
        await runNodesCommand("push", async () => {
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          const title = String(opts.title ?? "").trim() || "OpenClaw";
          const body = String(opts.body ?? "").trim() || `Push test for node ${nodeId}`;
          const environment = normalizeEnvironment(opts.environment);
          if (opts.environment && !environment) {
            throw new Error("invalid --environment (use sandbox|production)");
          }

          const params: Record<string, unknown> = {
            nodeId,
            title,
            body,
          };
          if (environment) {
            params.environment = environment;
          }

          const result = await callGatewayCli("push.test", opts, params);
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }

          const parsed =
            typeof result === "object" && result !== null
              ? (result as {
                  ok?: unknown;
                  status?: unknown;
                  reason?: unknown;
                  environment?: unknown;
                })
              : {};
          const ok = parsed.ok === true;
          const status = typeof parsed.status === "number" ? parsed.status : 0;
          const reason =
            typeof parsed.reason === "string" && parsed.reason.trim().length > 0
              ? parsed.reason.trim()
              : undefined;
          const env =
            typeof parsed.environment === "string" && parsed.environment.trim().length > 0
              ? parsed.environment.trim()
              : "unknown";
          const { ok: okLabel, error: errorLabel } = getNodesTheme();
          const label = ok ? okLabel : errorLabel;
          defaultRuntime.log(label(`push.test status=${status} ok=${ok} env=${env}`));
          if (reason) {
            defaultRuntime.log(`reason: ${reason}`);
          }
        });
      }),
    { timeoutMs: 25_000 },
  );
}
