import type { Command } from "commander";
import type { NodeListNode, NodesRpcOpts } from "./types.js";
import { callGateway } from "../../gateway/call.js";
import { resolveNodeIdFromCandidates } from "../../shared/node-match.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { withProgress } from "../progress.js";
import { parseNodeList, parsePairingList } from "./format.js";

export const nodesCallOpts = (cmd: Command, defaults?: { timeoutMs?: number }) =>
  cmd
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--timeout <ms>", "Timeout in ms", String(defaults?.timeoutMs ?? 10_000))
    .option("--json", "Output JSON", false);

export const callGatewayCli = async (
  method: string,
  opts: NodesRpcOpts,
  params?: unknown,
  callOpts?: { transportTimeoutMs?: number },
) =>
  withProgress(
    {
      label: `Nodes ${method}`,
      indeterminate: true,
      enabled: opts.json !== true,
    },
    async () =>
      await callGateway({
        url: opts.url,
        token: opts.token,
        method,
        params,
        timeoutMs: callOpts?.transportTimeoutMs ?? Number(opts.timeout ?? 10_000),
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      }),
  );

export function unauthorizedHintForMessage(message: string): string | null {
  const haystack = message.toLowerCase();
  if (
    haystack.includes("unauthorizedclient") ||
    haystack.includes("bridge client is not authorized") ||
    haystack.includes("unsigned bridge clients are not allowed")
  ) {
    return [
      "peekaboo bridge rejected the client.",
      "sign the peekaboo CLI (TeamID Y5PE65HELJ) or launch the host with",
      "PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1 for local dev.",
    ].join(" ");
  }
  return null;
}

export async function resolveNodeId(opts: NodesRpcOpts, query: string) {
  const q = String(query ?? "").trim();
  if (!q) {
    throw new Error("node required");
  }

  let nodes: NodeListNode[] = [];
  try {
    const res = await callGatewayCli("node.list", opts, {});
    nodes = parseNodeList(res);
  } catch {
    const res = await callGatewayCli("node.pair.list", opts, {});
    const { paired } = parsePairingList(res);
    nodes = paired.map((n) => ({
      nodeId: n.nodeId,
      displayName: n.displayName,
      platform: n.platform,
      version: n.version,
      remoteIp: n.remoteIp,
    }));
  }
  return resolveNodeIdFromCandidates(nodes, q);
}
