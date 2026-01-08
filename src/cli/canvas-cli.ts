import fs from "node:fs/promises";

import type { Command } from "commander";
import { callGateway, randomIdempotencyKey } from "../gateway/call.js";
import { defaultRuntime } from "../runtime.js";
import { writeBase64ToFile } from "./nodes-camera.js";
import {
  canvasSnapshotTempPath,
  parseCanvasSnapshotPayload,
} from "./nodes-canvas.js";
import { withProgress } from "./progress.js";

type CanvasOpts = {
  url?: string;
  token?: string;
  timeout?: string;
  json?: boolean;
  node?: string;
  target?: string;
  x?: string;
  y?: string;
  width?: string;
  height?: string;
  js?: string;
  jsonl?: string;
  text?: string;
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

const A2UI_ACTION_KEYS = [
  "beginRendering",
  "surfaceUpdate",
  "dataModelUpdate",
  "deleteSurface",
  "createSurface",
] as const;

type A2UIVersion = "v0.8" | "v0.9";

const canvasCallOpts = (cmd: Command) =>
  cmd
    .option(
      "--url <url>",
      "Gateway WebSocket URL (defaults to gateway.remote.url when configured)",
    )
    .option("--token <token>", "Gateway token (if required)")
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .option("--json", "Output JSON", false);

const callGatewayCli = async (
  method: string,
  opts: CanvasOpts,
  params?: unknown,
) =>
  withProgress(
    {
      label: `Canvas ${method}`,
      indeterminate: true,
      enabled: opts.json !== true,
    },
    async () =>
      await callGateway({
        url: opts.url,
        token: opts.token,
        method,
        params,
        timeoutMs: Number(opts.timeout ?? 10_000),
        clientName: "cli",
        mode: "cli",
      }),
  );

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

function buildA2UITextJsonl(text: string) {
  const surfaceId = "main";
  const rootId = "root";
  const textId = "text";
  const payloads = [
    {
      surfaceUpdate: {
        surfaceId,
        components: [
          {
            id: rootId,
            component: { Column: { children: { explicitList: [textId] } } },
          },
          {
            id: textId,
            component: {
              Text: { text: { literalString: text }, usageHint: "body" },
            },
          },
        ],
      },
    },
    { beginRendering: { surfaceId, root: rootId } },
  ];
  return payloads.map((payload) => JSON.stringify(payload)).join("\n");
}

function validateA2UIJsonl(jsonl: string) {
  const lines = jsonl.split(/\r?\n/);
  const errors: string[] = [];
  let sawV08 = false;
  let sawV09 = false;
  let messageCount = 0;

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    messageCount += 1;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed) as unknown;
    } catch (err) {
      errors.push(`line ${idx + 1}: ${String(err)}`);
      return;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      errors.push(`line ${idx + 1}: expected JSON object`);
      return;
    }
    const record = obj as Record<string, unknown>;
    const actionKeys = A2UI_ACTION_KEYS.filter((key) => key in record);
    if (actionKeys.length !== 1) {
      errors.push(
        `line ${idx + 1}: expected exactly one action key (${A2UI_ACTION_KEYS.join(
          ", ",
        )})`,
      );
      return;
    }
    if (actionKeys[0] === "createSurface") {
      sawV09 = true;
    } else {
      sawV08 = true;
    }
  });

  if (messageCount === 0) {
    errors.push("no JSONL messages found");
  }
  if (sawV08 && sawV09) {
    errors.push("mixed A2UI v0.8 and v0.9 messages in one file");
  }
  if (errors.length > 0) {
    throw new Error(`Invalid A2UI JSONL:\n- ${errors.join("\n- ")}`);
  }

  const version: A2UIVersion = sawV09 ? "v0.9" : "v0.8";
  return { version, messageCount };
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

  const local = candidates.filter(
    (n) =>
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
    .description("Control node canvases (present/navigate/eval/snapshot/a2ui)");

  const invokeCanvas = async (
    opts: CanvasOpts,
    command: string,
    params?: Record<string, unknown>,
  ) => {
    const nodeId = await resolveNodeId(opts, opts.node);
    await callGatewayCli("node.invoke", opts, {
      nodeId,
      command,
      params,
      idempotencyKey: randomIdempotencyKey(),
    });
  };

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

  canvasCallOpts(
    canvas
      .command("present")
      .description("Show the canvas (optionally with a target URL/path)")
      .option("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--target <urlOrPath>", "Target URL/path (optional)")
      .option("--x <px>", "Placement x coordinate")
      .option("--y <px>", "Placement y coordinate")
      .option("--width <px>", "Placement width")
      .option("--height <px>", "Placement height")
      .action(async (opts: CanvasOpts) => {
        try {
          const placement = {
            x: opts.x ? Number.parseFloat(opts.x) : undefined,
            y: opts.y ? Number.parseFloat(opts.y) : undefined,
            width: opts.width ? Number.parseFloat(opts.width) : undefined,
            height: opts.height ? Number.parseFloat(opts.height) : undefined,
          };
          const params: Record<string, unknown> = {};
          if (opts.target) params.url = String(opts.target);
          if (
            Number.isFinite(placement.x) ||
            Number.isFinite(placement.y) ||
            Number.isFinite(placement.width) ||
            Number.isFinite(placement.height)
          ) {
            params.placement = placement;
          }
          await invokeCanvas(opts, "canvas.present", params);
          if (!opts.json) {
            defaultRuntime.log("canvas present ok");
          }
        } catch (err) {
          defaultRuntime.error(`canvas present failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );

  canvasCallOpts(
    canvas
      .command("hide")
      .description("Hide the canvas")
      .option("--node <idOrNameOrIp>", "Node id, name, or IP")
      .action(async (opts: CanvasOpts) => {
        try {
          await invokeCanvas(opts, "canvas.hide", undefined);
          if (!opts.json) {
            defaultRuntime.log("canvas hide ok");
          }
        } catch (err) {
          defaultRuntime.error(`canvas hide failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );

  canvasCallOpts(
    canvas
      .command("navigate")
      .description("Navigate the canvas to a URL")
      .argument("<url>", "Target URL/path")
      .option("--node <idOrNameOrIp>", "Node id, name, or IP")
      .action(async (url: string, opts: CanvasOpts) => {
        try {
          await invokeCanvas(opts, "canvas.navigate", { url });
          if (!opts.json) {
            defaultRuntime.log("canvas navigate ok");
          }
        } catch (err) {
          defaultRuntime.error(`canvas navigate failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );

  canvasCallOpts(
    canvas
      .command("eval")
      .description("Evaluate JavaScript in the canvas")
      .argument("[js]", "JavaScript to evaluate")
      .option("--js <code>", "JavaScript to evaluate")
      .option("--node <idOrNameOrIp>", "Node id, name, or IP")
      .action(async (jsArg: string | undefined, opts: CanvasOpts) => {
        try {
          const js = opts.js ?? jsArg;
          if (!js) throw new Error("missing --js or <js>");
          const nodeId = await resolveNodeId(opts, opts.node);
          const raw = (await callGatewayCli("node.invoke", opts, {
            nodeId,
            command: "canvas.eval",
            params: { javaScript: js },
            idempotencyKey: randomIdempotencyKey(),
          })) as unknown;
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(raw, null, 2));
            return;
          }
          const payload =
            typeof raw === "object" && raw !== null
              ? (raw as { payload?: { result?: string } }).payload
              : undefined;
          if (payload?.result) {
            defaultRuntime.log(payload.result);
          } else {
            defaultRuntime.log("canvas eval ok");
          }
        } catch (err) {
          defaultRuntime.error(`canvas eval failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );

  const a2ui = canvas
    .command("a2ui")
    .description("Render A2UI content on the canvas");

  canvasCallOpts(
    a2ui
      .command("push")
      .description("Push A2UI JSONL to the canvas")
      .option("--jsonl <path>", "Path to JSONL payload")
      .option("--text <text>", "Render a quick A2UI text payload")
      .option("--node <idOrNameOrIp>", "Node id, name, or IP")
      .action(async (opts: CanvasOpts) => {
        try {
          const hasJsonl = Boolean(opts.jsonl);
          const hasText = typeof opts.text === "string";
          if (hasJsonl === hasText) {
            throw new Error("provide exactly one of --jsonl or --text");
          }

          const jsonl = hasText
            ? buildA2UITextJsonl(String(opts.text ?? ""))
            : await fs.readFile(String(opts.jsonl), "utf8");
          const { version, messageCount } = validateA2UIJsonl(jsonl);
          if (version === "v0.9") {
            throw new Error(
              "Detected A2UI v0.9 JSONL (createSurface). Clawdbot currently supports v0.8 only.",
            );
          }
          await invokeCanvas(opts, "canvas.a2ui.pushJSONL", { jsonl });
          if (!opts.json) {
            defaultRuntime.log(
              `canvas a2ui push ok (v0.8, ${messageCount} message${messageCount === 1 ? "" : "s"})`,
            );
          }
        } catch (err) {
          defaultRuntime.error(`canvas a2ui push failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );

  canvasCallOpts(
    a2ui
      .command("reset")
      .description("Reset A2UI renderer state")
      .option("--node <idOrNameOrIp>", "Node id, name, or IP")
      .action(async (opts: CanvasOpts) => {
        try {
          await invokeCanvas(opts, "canvas.a2ui.reset", undefined);
          if (!opts.json) {
            defaultRuntime.log("canvas a2ui reset ok");
          }
        } catch (err) {
          defaultRuntime.error(`canvas a2ui reset failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );
}
