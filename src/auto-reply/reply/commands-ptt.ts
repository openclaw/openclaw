import type { OpenClawConfig } from "../../config/config.js";
import type { CommandHandler } from "./commands-types.js";
import { callGateway, randomIdempotencyKey } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";

type NodeSummary = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  deviceFamily?: string;
  remoteIp?: string;
  connected?: boolean;
};

const PTT_COMMANDS: Record<string, string> = {
  start: "talk.ptt.start",
  stop: "talk.ptt.stop",
  once: "talk.ptt.once",
  cancel: "talk.ptt.cancel",
};

function normalizeNodeKey(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

function isIOSNode(node: NodeSummary): boolean {
  const platform = node.platform?.toLowerCase() ?? "";
  const family = node.deviceFamily?.toLowerCase() ?? "";
  return (
    platform.startsWith("ios") ||
    family.includes("iphone") ||
    family.includes("ipad") ||
    family.includes("ios")
  );
}

async function loadNodes(cfg: OpenClawConfig): Promise<NodeSummary[]> {
  try {
    const res = await callGateway<{ nodes?: NodeSummary[] }>({
      method: "node.list",
      params: {},
      config: cfg,
    });
    return Array.isArray(res.nodes) ? res.nodes : [];
  } catch {
    const res = await callGateway<{ pending?: unknown[]; paired?: NodeSummary[] }>({
      method: "node.pair.list",
      params: {},
      config: cfg,
    });
    return Array.isArray(res.paired) ? res.paired : [];
  }
}

function describeNodes(nodes: NodeSummary[]) {
  return nodes
    .map((node) => node.displayName || node.remoteIp || node.nodeId)
    .filter(Boolean)
    .join(", ");
}

function resolveNodeId(nodes: NodeSummary[], query?: string): string {
  const trimmed = String(query ?? "").trim();
  if (trimmed) {
    const qNorm = normalizeNodeKey(trimmed);
    const matches = nodes.filter((node) => {
      if (node.nodeId === trimmed) {
        return true;
      }
      if (typeof node.remoteIp === "string" && node.remoteIp === trimmed) {
        return true;
      }
      const name = typeof node.displayName === "string" ? node.displayName : "";
      if (name && normalizeNodeKey(name) === qNorm) {
        return true;
      }
      if (trimmed.length >= 6 && node.nodeId.startsWith(trimmed)) {
        return true;
      }
      return false;
    });

    if (matches.length === 1) {
      return matches[0].nodeId;
    }
    const known = describeNodes(nodes);
    if (matches.length === 0) {
      throw new Error(`unknown node: ${trimmed}${known ? ` (known: ${known})` : ""}`);
    }
    throw new Error(
      `ambiguous node: ${trimmed} (matches: ${matches
        .map((node) => node.displayName || node.remoteIp || node.nodeId)
        .join(", ")})`,
    );
  }

  const iosNodes = nodes.filter(isIOSNode);
  const iosConnected = iosNodes.filter((node) => node.connected);
  const iosCandidates = iosConnected.length > 0 ? iosConnected : iosNodes;
  if (iosCandidates.length === 1) {
    return iosCandidates[0].nodeId;
  }
  if (iosCandidates.length > 1) {
    throw new Error(
      `multiple iOS nodes found (${describeNodes(iosCandidates)}); specify node=<id>`,
    );
  }

  const connected = nodes.filter((node) => node.connected);
  const fallback = connected.length > 0 ? connected : nodes;
  if (fallback.length === 1) {
    return fallback[0].nodeId;
  }

  const known = describeNodes(nodes);
  throw new Error(`node required${known ? ` (known: ${known})` : ""}`);
}

function parsePTTArgs(commandBody: string) {
  const tokens = commandBody.trim().split(/\s+/).slice(1);
  let action: string | undefined;
  let node: string | undefined;
  for (const token of tokens) {
    if (!token) {
      continue;
    }
    if (token.toLowerCase().startsWith("node=")) {
      node = token.slice("node=".length);
      continue;
    }
    if (!action) {
      action = token;
    }
  }
  return { action, node };
}

function buildPTTHelpText() {
  return [
    "Usage: /ptt <start|stop|once|cancel> [node=<id>]",
    "Example: /ptt once node=iphone",
  ].join("\n");
}

export const handlePTTCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const { command, cfg } = params;
  const normalized = command.commandBodyNormalized.trim();
  if (!normalized.startsWith("/ptt")) {
    return null;
  }
  if (!command.isAuthorizedSender) {
    logVerbose(`Ignoring /ptt from unauthorized sender: ${command.senderId || "<unknown>"}`);
    return { shouldContinue: false, reply: { text: "PTT requires an authorized sender." } };
  }

  const parsed = parsePTTArgs(normalized);
  const actionKey = parsed.action?.trim().toLowerCase() ?? "";
  const commandId = PTT_COMMANDS[actionKey];
  if (!commandId) {
    return { shouldContinue: false, reply: { text: buildPTTHelpText() } };
  }

  try {
    const nodes = await loadNodes(cfg);
    const nodeId = resolveNodeId(nodes, parsed.node);
    const invokeParams: Record<string, unknown> = {
      nodeId,
      command: commandId,
      params: {},
      idempotencyKey: randomIdempotencyKey(),
      timeoutMs: 15_000,
    };
    const res = await callGateway<{
      ok?: boolean;
      payload?: Record<string, unknown>;
      command?: string;
      nodeId?: string;
    }>({
      method: "node.invoke",
      params: invokeParams,
      config: cfg,
    });
    const payload =
      res.payload && typeof res.payload === "object"
        ? (res.payload as Record<string, unknown>)
        : {};

    const lines = [`PTT ${actionKey} → ${nodeId}`];
    if (typeof payload.status === "string") {
      lines.push(`status: ${payload.status}`);
    }
    if (typeof payload.captureId === "string") {
      lines.push(`captureId: ${payload.captureId}`);
    }
    if (typeof payload.transcript === "string" && payload.transcript.trim()) {
      lines.push(`transcript: ${payload.transcript}`);
    }

    return { shouldContinue: false, reply: { text: lines.join("\n") } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { shouldContinue: false, reply: { text: `PTT failed: ${message}` } };
  }
};
