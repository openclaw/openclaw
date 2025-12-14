import type { Command } from "commander";
import { callGateway, randomIdempotencyKey } from "../gateway/call.js";
import { defaultRuntime } from "../runtime.js";
import {
  type CameraFacing,
  cameraTempPath,
  parseCameraClipPayload,
  parseCameraSnapPayload,
  writeBase64ToFile,
} from "./nodes-camera.js";

type NodesRpcOpts = {
  url?: string;
  token?: string;
  timeout?: string;
  json?: boolean;
  node?: string;
  command?: string;
  params?: string;
  invokeTimeout?: string;
  idempotencyKey?: string;
  facing?: string;
  maxWidth?: string;
  quality?: string;
  duration?: string;
  audio?: boolean;
};

type NodeListNode = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  remoteIp?: string;
  connected?: boolean;
};

type PendingRequest = {
  requestId: string;
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  remoteIp?: string;
  isRepair?: boolean;
  ts: number;
};

type PairedNode = {
  nodeId: string;
  token?: string;
  displayName?: string;
  platform?: string;
  version?: string;
  remoteIp?: string;
  createdAtMs?: number;
  approvedAtMs?: number;
};

type PairingList = {
  pending: PendingRequest[];
  paired: PairedNode[];
};

const nodesCallOpts = (cmd: Command, defaults?: { timeoutMs?: number }) =>
  cmd
    .option("--url <url>", "Gateway WebSocket URL", "ws://127.0.0.1:18789")
    .option("--token <token>", "Gateway token (if required)")
    .option(
      "--timeout <ms>",
      "Timeout in ms",
      String(defaults?.timeoutMs ?? 10_000),
    )
    .option("--json", "Output JSON", false);

const callGatewayCli = async (
  method: string,
  opts: NodesRpcOpts,
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

function formatAge(msAgo: number) {
  const s = Math.max(0, Math.floor(msAgo / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
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

function parseNodeList(value: unknown): NodeListNode[] {
  const obj =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  return Array.isArray(obj.nodes) ? (obj.nodes as NodeListNode[]) : [];
}

function normalizeNodeKey(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

async function resolveNodeId(opts: NodesRpcOpts, query: string) {
  const q = String(query ?? "").trim();
  if (!q) throw new Error("node required");

  let nodes: NodeListNode[] = [];
  try {
    const res = (await callGatewayCli("node.list", opts, {})) as unknown;
    nodes = parseNodeList(res);
  } catch {
    const res = (await callGatewayCli("node.pair.list", opts, {})) as unknown;
    const { paired } = parsePairingList(res);
    nodes = paired.map((n) => ({
      nodeId: n.nodeId,
      displayName: n.displayName,
      platform: n.platform,
      version: n.version,
      remoteIp: n.remoteIp,
    }));
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

export function registerNodesCli(program: Command) {
  const nodes = program
    .command("nodes")
    .description("Manage gateway-owned node pairing");

  nodesCallOpts(
    nodes
      .command("list")
      .description("List pending and paired nodes")
      .action(async (opts: NodesRpcOpts) => {
        try {
          const result = (await callGatewayCli(
            "node.pair.list",
            opts,
            {},
          )) as unknown;
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          const { pending, paired } = parsePairingList(result);
          defaultRuntime.log(
            `Pending: ${pending.length} · Paired: ${paired.length}`,
          );
          if (pending.length > 0) {
            defaultRuntime.log("\nPending:");
            for (const r of pending) {
              const name = r.displayName || r.nodeId;
              const repair = r.isRepair ? " (repair)" : "";
              const ip = r.remoteIp ? ` · ${r.remoteIp}` : "";
              const age =
                typeof r.ts === "number"
                  ? ` · ${formatAge(Date.now() - r.ts)} ago`
                  : "";
              defaultRuntime.log(
                `- ${r.requestId}: ${name}${repair}${ip}${age}`,
              );
            }
          }
          if (paired.length > 0) {
            defaultRuntime.log("\nPaired:");
            for (const n of paired) {
              const name = n.displayName || n.nodeId;
              const ip = n.remoteIp ? ` · ${n.remoteIp}` : "";
              defaultRuntime.log(`- ${n.nodeId}: ${name}${ip}`);
            }
          }
        } catch (err) {
          defaultRuntime.error(`nodes list failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );

  nodesCallOpts(
    nodes
      .command("pending")
      .description("List pending pairing requests")
      .action(async (opts: NodesRpcOpts) => {
        try {
          const result = (await callGatewayCli(
            "node.pair.list",
            opts,
            {},
          )) as unknown;
          const { pending } = parsePairingList(result);
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(pending, null, 2));
            return;
          }
          if (pending.length === 0) {
            defaultRuntime.log("No pending pairing requests.");
            return;
          }
          for (const r of pending) {
            const name = r.displayName || r.nodeId;
            const repair = r.isRepair ? " (repair)" : "";
            const ip = r.remoteIp ? ` · ${r.remoteIp}` : "";
            const age =
              typeof r.ts === "number"
                ? ` · ${formatAge(Date.now() - r.ts)} ago`
                : "";
            defaultRuntime.log(`- ${r.requestId}: ${name}${repair}${ip}${age}`);
          }
        } catch (err) {
          defaultRuntime.error(`nodes pending failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );

  nodesCallOpts(
    nodes
      .command("approve")
      .description("Approve a pending pairing request")
      .argument("<requestId>", "Pending request id")
      .action(async (requestId: string, opts: NodesRpcOpts) => {
        try {
          const result = await callGatewayCli("node.pair.approve", opts, {
            requestId,
          });
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(`nodes approve failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );

  nodesCallOpts(
    nodes
      .command("reject")
      .description("Reject a pending pairing request")
      .argument("<requestId>", "Pending request id")
      .action(async (requestId: string, opts: NodesRpcOpts) => {
        try {
          const result = await callGatewayCli("node.pair.reject", opts, {
            requestId,
          });
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(`nodes reject failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );

  nodesCallOpts(
    nodes
      .command("invoke")
      .description("Invoke a command on a paired node")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .requiredOption("--command <command>", "Command (e.g. screen.eval)")
      .option("--params <json>", "JSON object string for params", "{}")
      .option(
        "--invoke-timeout <ms>",
        "Node invoke timeout in ms (default 15000)",
        "15000",
      )
      .option("--idempotency-key <key>", "Idempotency key (optional)")
      .action(async (opts: NodesRpcOpts) => {
        try {
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          const command = String(opts.command ?? "").trim();
          if (!nodeId || !command) {
            defaultRuntime.error("--node and --command required");
            defaultRuntime.exit(1);
            return;
          }
          const params = JSON.parse(String(opts.params ?? "{}")) as unknown;
          const timeoutMs = opts.invokeTimeout
            ? Number.parseInt(String(opts.invokeTimeout), 10)
            : undefined;

          const invokeParams: Record<string, unknown> = {
            nodeId,
            command,
            params,
            idempotencyKey: String(
              opts.idempotencyKey ?? randomIdempotencyKey(),
            ),
          };
          if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) {
            invokeParams.timeoutMs = timeoutMs;
          }

          const result = await callGatewayCli(
            "node.invoke",
            opts,
            invokeParams,
          );

          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(`nodes invoke failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
    { timeoutMs: 30_000 },
  );

  const parseFacing = (value: string): CameraFacing => {
    const v = String(value ?? "")
      .trim()
      .toLowerCase();
    if (v === "front" || v === "back") return v;
    throw new Error(`invalid facing: ${value} (expected front|back)`);
  };

  const camera = nodes
    .command("camera")
    .description("Capture camera media from a paired node");

  nodesCallOpts(
    camera
      .command("snap")
      .description("Capture a photo from a node camera (prints MEDIA:<path>)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--facing <front|back|both>", "Camera facing", "both")
      .option("--max-width <px>", "Max width in px (optional)")
      .option("--quality <0-1>", "JPEG quality (default 0.9)")
      .option(
        "--invoke-timeout <ms>",
        "Node invoke timeout in ms (default 20000)",
        "20000",
      )
      .action(async (opts: NodesRpcOpts) => {
        try {
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          const facingOpt = String(opts.facing ?? "both")
            .trim()
            .toLowerCase();
          const facings: CameraFacing[] =
            facingOpt === "both"
              ? ["front", "back"]
              : facingOpt === "front" || facingOpt === "back"
                ? [facingOpt]
                : (() => {
                    throw new Error(
                      `invalid facing: ${String(opts.facing)} (expected front|back|both)`,
                    );
                  })();

          const maxWidth = opts.maxWidth
            ? Number.parseInt(String(opts.maxWidth), 10)
            : undefined;
          const quality = opts.quality
            ? Number.parseFloat(String(opts.quality))
            : undefined;
          const timeoutMs = opts.invokeTimeout
            ? Number.parseInt(String(opts.invokeTimeout), 10)
            : undefined;

          const results: Array<{
            facing: CameraFacing;
            path: string;
            width: number;
            height: number;
          }> = [];

          for (const facing of facings) {
            const invokeParams: Record<string, unknown> = {
              nodeId,
              command: "camera.snap",
              params: {
                facing,
                maxWidth: Number.isFinite(maxWidth) ? maxWidth : undefined,
                quality: Number.isFinite(quality) ? quality : undefined,
                format: "jpg",
              },
              idempotencyKey: randomIdempotencyKey(),
            };
            if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) {
              invokeParams.timeoutMs = timeoutMs;
            }

            const raw = (await callGatewayCli(
              "node.invoke",
              opts,
              invokeParams,
            )) as unknown;

            const res =
              typeof raw === "object" && raw !== null
                ? (raw as { payload?: unknown })
                : {};
            const payload = parseCameraSnapPayload(res.payload);
            const filePath = cameraTempPath({
              kind: "snap",
              facing,
              ext: payload.format === "jpeg" ? "jpg" : payload.format,
            });
            await writeBase64ToFile(filePath, payload.base64);
            results.push({
              facing,
              path: filePath,
              width: payload.width,
              height: payload.height,
            });
          }

          if (opts.json) {
            defaultRuntime.log(JSON.stringify({ files: results }, null, 2));
            return;
          }
          defaultRuntime.log(results.map((r) => `MEDIA:${r.path}`).join("\n"));
        } catch (err) {
          defaultRuntime.error(`nodes camera snap failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
    { timeoutMs: 60_000 },
  );

  nodesCallOpts(
    camera
      .command("clip")
      .description(
        "Capture a short video clip from a node camera (prints MEDIA:<path>)",
      )
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--facing <front|back>", "Camera facing", "front")
      .option("--duration <ms>", "Duration in ms (default 3000)", "3000")
      .option("--no-audio", "Disable audio capture")
      .option(
        "--invoke-timeout <ms>",
        "Node invoke timeout in ms (default 45000)",
        "45000",
      )
      .action(async (opts: NodesRpcOpts & { audio?: boolean }) => {
        try {
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          const facing = parseFacing(String(opts.facing ?? "front"));
          const durationMs = Number.parseInt(
            String(opts.duration ?? "3000"),
            10,
          );
          const includeAudio = opts.audio !== false;
          const timeoutMs = opts.invokeTimeout
            ? Number.parseInt(String(opts.invokeTimeout), 10)
            : undefined;

          const invokeParams: Record<string, unknown> = {
            nodeId,
            command: "camera.clip",
            params: {
              facing,
              durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
              includeAudio,
              format: "mp4",
            },
            idempotencyKey: randomIdempotencyKey(),
          };
          if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) {
            invokeParams.timeoutMs = timeoutMs;
          }

          const raw = (await callGatewayCli(
            "node.invoke",
            opts,
            invokeParams,
          )) as unknown;
          const res =
            typeof raw === "object" && raw !== null
              ? (raw as { payload?: unknown })
              : {};
          const payload = parseCameraClipPayload(res.payload);
          const filePath = cameraTempPath({
            kind: "clip",
            facing,
            ext: payload.format,
          });
          await writeBase64ToFile(filePath, payload.base64);

          if (opts.json) {
            defaultRuntime.log(
              JSON.stringify(
                {
                  file: {
                    facing,
                    path: filePath,
                    durationMs: payload.durationMs,
                    hasAudio: payload.hasAudio,
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
          defaultRuntime.error(`nodes camera clip failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
    { timeoutMs: 90_000 },
  );
}
