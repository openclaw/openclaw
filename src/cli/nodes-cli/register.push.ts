import { asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { getNodesTheme, runNodesCommand } from "./cli-utils.js";
import { callNodesGatewayCli, nodesCallOpts, resolveCliNodeId } from "./rpc.js";
import type { NodesRpcOpts } from "./types.js";

export function registerNodesPushCommand(nodes: Command) {
  nodesCallOpts(
    nodes
      .command("push")
      .description("Send an APNs test push to an iOS node")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--title <text>", "Push title", "OpenClaw")
      .option("--body <text>", "Push body")
      .option("--environment <sandbox|production>", "Override APNs environment")
      .action(async (opts: NodesRpcOpts & { environment?: string }) => {
        await runNodesCommand("push", async () => {
          const environment = normalizeOptionalLowercaseString(opts.environment);
          if (
            opts.environment !== undefined &&
            environment !== "sandbox" &&
            environment !== "production"
          ) {
            throw new Error("invalid --environment (use sandbox|production)");
          }
          const nodeId = await resolveCliNodeId(opts, opts.node ?? "");
          const title = normalizeOptionalString(opts.title) || "OpenClaw";
          const body = normalizeOptionalString(opts.body) || `Push test for node ${nodeId}`;

          const result = await callNodesGatewayCli("push.test", opts, {
            nodeId,
            title,
            body,
            ...(environment ? { environment } : {}),
          });
          const parsed = asRecord(result);
          const ok = parsed.ok === true;
          const status = typeof parsed.status === "number" ? parsed.status : 0;
          const reason = normalizeOptionalString(parsed.reason);
          const env = normalizeOptionalString(parsed.environment) ?? "unknown";
          if (opts.json) {
            defaultRuntime.writeJson(result);
          } else {
            const { ok: okLabel, error: errorLabel } = getNodesTheme();
            const label = ok ? okLabel : errorLabel;
            defaultRuntime.log(label(`push.test status=${status} ok=${ok} env=${env}`));
            if (reason) {
              defaultRuntime.log(`reason: ${reason}`);
            }
          }
          if (!ok) {
            // Defer termination so the complete human/JSON result reaches stdout.
            process.exitCode = 1;
          }
        });
      }),
    { timeoutMs: 25_000 },
  );
}
