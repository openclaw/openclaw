import type { Command } from "commander";
import type { NodesRpcOpts } from "./types.js";
import { randomIdempotencyKey } from "../../gateway/call.js";
import { defaultRuntime } from "../../runtime.js";
import { runNodesCommand } from "./cli-utils.js";
import { callGatewayCli, nodesCallOpts, resolveNodeId } from "./rpc.js";

type PTTAction = {
  name: string;
  command: string;
  description: string;
};

const PTT_ACTIONS: PTTAction[] = [
  { name: "start", command: "talk.ptt.start", description: "Start push-to-talk capture" },
  { name: "stop", command: "talk.ptt.stop", description: "Stop push-to-talk capture" },
  { name: "once", command: "talk.ptt.once", description: "Run push-to-talk once" },
  { name: "cancel", command: "talk.ptt.cancel", description: "Cancel push-to-talk capture" },
];

export function registerNodesTalkCommands(nodes: Command) {
  const talk = nodes.command("talk").description("Talk/voice controls on a paired node");
  const ptt = talk.command("ptt").description("Push-to-talk controls");

  for (const action of PTT_ACTIONS) {
    nodesCallOpts(
      ptt
        .command(action.name)
        .description(action.description)
        .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
        .option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 15000)", "15000")
        .action(async (opts: NodesRpcOpts) => {
          await runNodesCommand(`talk ptt ${action.name}`, async () => {
            const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
            const invokeTimeoutMs = opts.invokeTimeout
              ? Number.parseInt(String(opts.invokeTimeout), 10)
              : undefined;

            const invokeParams: Record<string, unknown> = {
              nodeId,
              command: action.command,
              params: {},
              idempotencyKey: randomIdempotencyKey(),
            };
            if (typeof invokeTimeoutMs === "number" && Number.isFinite(invokeTimeoutMs)) {
              invokeParams.timeoutMs = invokeTimeoutMs;
            }

            const raw = await callGatewayCli("node.invoke", opts, invokeParams);
            const res =
              typeof raw === "object" && raw !== null ? (raw as { payload?: unknown }) : {};
            const payload =
              res.payload && typeof res.payload === "object"
                ? (res.payload as Record<string, unknown>)
                : {};

            if (opts.json) {
              defaultRuntime.log(JSON.stringify(payload, null, 2));
              return;
            }

            const lines = [`PTT ${action.name} → ${nodeId}`];
            if (typeof payload.status === "string") {
              lines.push(`status: ${payload.status}`);
            }
            if (typeof payload.captureId === "string") {
              lines.push(`captureId: ${payload.captureId}`);
            }
            if (typeof payload.transcript === "string" && payload.transcript.trim()) {
              lines.push(`transcript: ${payload.transcript}`);
            }

            defaultRuntime.log(lines.join("\n"));
          });
        }),
      { timeoutMs: 30_000 },
    );
  }
}
