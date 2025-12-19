import type { Command } from "commander";
import { callGateway, randomIdempotencyKey } from "../gateway/call.js";
import { defaultRuntime } from "../runtime.js";
import { writeBase64ToFile } from "./nodes-camera.js";
import {
  canvasSnapshotTempPath,
  parseCanvasSnapshotPayload,
} from "./nodes-canvas.js";

type CanvasOpts = {
  url?: string;
  token?: string;
  timeout?: string;
  json?: boolean;
  node?: string;
  format?: string;
  maxWidth?: string;
  quality?: string;
};

type NodeListNode = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  remoteIp?: string;
  caps?: string[];
  connected?: boolean;
};

type PendingRequest = {
  requestId: string;
  nodeId: string;
  displayName?: string;
  remoteIp?: string;
};

type PairedNode = {
  nodeId: string;
  displayName?: string;
  remoteIp?: string;
};

type PairingList = {
  pending: PendingRequest[];
  paired: PairedNode[];
};

const canvasCallOpts = (cmd: Command) =>
  cmd
    .option("--url <url>", "Gateway WebSocket URL", "ws://127.0.0.1:18789")
    .option("--token <token>", "Gateway token (if required)")
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .option("--json", "Output JSON", false);

const callGatewayCli = async (
  method: string,
  opts: CanvasOpts,
  params?: unknown,
) =>
  callGateway({
    url: opts.url,
    token: opts.token,
    method,
    params,
    timeoutMs: Number(opts.timeout ?? 10_000),
    clientName: "cli",
    mode: "cli",
  });

function parseNodeList(value: unknown): NodeListNode[] {
  const obj =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  return Array.isArray(obj.nodes) ? (obj.nodes as NodeListNode[]) : [];
}

function parsePairingList(value: unknown): PairingList {
  const obj =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const pending = Array.isArray(obj.pending)
    ? (obj.pending as PendingRequest[])
    : [];
  const paired = Array.isArray(obj.paired) ? (obj.paired as PairedNode[]) : [];
  return { pending, paired };
}

function normalizeNodeKey(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

async function loadNodes(opts: CanvasOpts): Promise<NodeListNode[]> {
  try {
    const res = (await callGatewayCli("node.list", opts, {})) as unknown;
    return parseNodeList(res);
  } catch {
    const res = (await callGatewayCli("node.pair.list", opts, {})) as unknown;
    const { paired } = parsePairingList(res);
    return paired.map((n) => ({
      nodeId: n.nodeId,
      displayName: n.displayName,
      remoteIp: n.remoteIp,
    }));
  }
}

function pickDefaultNode(nodes: NodeListNode[]): NodeListNode | null {
  const withCanvas = nodes.filter((n) =>
    Array.isArray(n.caps) ? n.caps.includes("canvas") : true,
  );
  if (withCanvas.length === 0) return null;

  const connected = withCanvas.filter((n) => n.connected);
  const candidates = connected.length > 0 ? connected : withCanvas;
  if (candidates.length === 1) return candidates[0];

  const local = candidates.filter((n) =>
    n.platform?.toLowerCase().startsWith("mac") &&
    typeof n.nodeId === "string" &&
    n.nodeId.startsWith("mac-"),
  );
  if (local.length === 1) return local[0];

  return null;
}

async function resolveNodeId(opts: CanvasOpts, query?: string) {
  const nodes = await loadNodes(opts);
  const q = String(query ?? "").trim();
  if (!q) {
    const picked = pickDefaultNode(nodes);
    if (picked) return picked.nodeId;
    throw new Error(
      "node required (use --node or ensure only one connected node is available)",
    );
  }

  const qNorm = normalizeNodeKey(q);
  const matches = nodes.filter((n) => {
    if (n.nodeId === q) return true;
    if (typeof n.remoteIp === "string" && n.remoteIp === q) return true;
    const name = typeof n.displayName === "string" ? n.displayName : "";
    if (name && normalizeNodeKey(name) === qNorm) return true;
    if (q.length >= 6 && n.nodeId.startsWith(q)) return true;
    return false;
  });

  if (matches.length === 1) return matches[0].nodeId;
  if (matches.length === 0) {
    const known = nodes
      .map((n) => n.displayName || n.remoteIp || n.nodeId)
      .filter(Boolean)
      .join(", ");
    throw new Error(`unknown node: ${q}${known ? ` (known: ${known})` : ""}`);
  }
  throw new Error(
    `ambiguous node: ${q} (matches: ${matches
      .map((n) => n.displayName || n.remoteIp || n.nodeId)
      .join(", ")})`,
  );
}

function normalizeFormat(format: string) {
  const trimmed = format.trim().toLowerCase();
  if (trimmed === "jpg") return "jpeg";
  return trimmed;
}

export function registerCanvasCli(program: Command) {
  const canvas = program
    .command("canvas")
    .description("Render the canvas to a snapshot via nodes");

  canvasCallOpts(
    canvas
      .command("snapshot")
      .description("Capture a canvas snapshot (prints MEDIA:<path>)")
      .option("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--format <png|jpg>", "Output format", "png")
      .option("--max-width <px>", "Max width (px)")
      .option("--quality <0-1>", "JPEG quality (default 0.82)")
      .action(async (opts: CanvasOpts) => {
        try {
          const nodeId = await resolveNodeId(opts, opts.node);
          const format = normalizeFormat(String(opts.format ?? "png"));
          if (format !== "png" && format !== "jpeg") {
            throw new Error("invalid format (use png or jpg)");
          }
          const maxWidth = opts.maxWidth
            ? Number.parseInt(String(opts.maxWidth), 10)
            : undefined;
          const quality = opts.quality
            ? Number.parseFloat(String(opts.quality))
            : undefined;

          const raw = (await callGatewayCli("node.invoke", opts, {
            nodeId,
            command: "canvas.snapshot",
            params: {
              format,
              maxWidth: Number.isFinite(maxWidth) ? maxWidth : undefined,
              quality: Number.isFinite(quality) ? quality : undefined,
            },
            idempotencyKey: randomIdempotencyKey(),
          })) as unknown;

          const res =
            typeof raw === "object" && raw !== null
              ? (raw as { payload?: unknown })
              : {};
          const payload = parseCanvasSnapshotPayload(res.payload);
          const filePath = canvasSnapshotTempPath({
            ext: payload.format === "jpeg" ? "jpg" : payload.format,
          });
          await writeBase64ToFile(filePath, payload.base64);

          if (opts.json) {
            defaultRuntime.log(
              JSON.stringify(
                {
                  file: {
                    path: filePath,
                  },
                },
                null,
                2,
              ),
            );
            return;
          }
          defaultRuntime.log(`MEDIA:${filePath}`);
        } catch (err) {
          defaultRuntime.error(`canvas snapshot failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );
}
