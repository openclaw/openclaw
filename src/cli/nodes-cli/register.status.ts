import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { formatAge, formatPermissions, parseNodeList, parsePairingList } from "./format.js";
import { runNodesCommand } from "./cli-utils.js";
import { callGatewayCli, nodesCallOpts, resolveNodeId } from "./rpc.js";
import type { NodesRpcOpts } from "./types.js";
import { renderTable } from "../../terminal/table.js";
import { isRich, theme } from "../../terminal/theme.js";

function formatVersionLabel(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  if (trimmed.toLowerCase().startsWith("v")) return trimmed;
  return /^\d/.test(trimmed) ? `v${trimmed}` : trimmed;
}

function resolveNodeVersions(node: {
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
}) {
  const core = node.coreVersion?.trim() || undefined;
  const ui = node.uiVersion?.trim() || undefined;
  if (core || ui) return { core, ui };
  const legacy = node.version?.trim();
  if (!legacy) return { core: undefined, ui: undefined };
  const platform = node.platform?.trim().toLowerCase() ?? "";
  const headless =
    platform === "darwin" || platform === "linux" || platform === "win32" || platform === "windows";
  return headless ? { core: legacy, ui: undefined } : { core: undefined, ui: legacy };
}

function formatNodeVersions(node: {
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
}) {
  const { core, ui } = resolveNodeVersions(node);
  const parts: string[] = [];
  if (core) parts.push(`core ${formatVersionLabel(core)}`);
  if (ui) parts.push(`ui ${formatVersionLabel(ui)}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function registerNodesStatusCommands(nodes: Command) {
  nodesCallOpts(
    nodes
      .command("status")
      .description("List known nodes with connection status and capabilities")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("status", async () => {
          const result = (await callGatewayCli("node.list", opts, {})) as unknown;
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          const rich = isRich();
          const ok = (text: string) => (rich ? theme.success(text) : text);
          const warn = (text: string) => (rich ? theme.warn(text) : text);
          const muted = (text: string) => (rich ? theme.muted(text) : text);
          const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
          const nodes = parseNodeList(result);
          const pairedCount = nodes.filter((n) => Boolean(n.paired)).length;
          const connectedCount = nodes.filter((n) => Boolean(n.connected)).length;
          defaultRuntime.log(
            `Known: ${nodes.length} · Paired: ${pairedCount} · Connected: ${connectedCount}`,
          );
          if (nodes.length === 0) return;

          const rows = nodes.map((n) => {
            const name = n.displayName?.trim() ? n.displayName.trim() : n.nodeId;
            const device = (() => {
              if (n.deviceFamily && n.modelIdentifier) {
                return `${n.deviceFamily} (${n.modelIdentifier})`;
              }
              return n.deviceFamily ?? n.modelIdentifier ?? "";
            })();
            const caps = Array.isArray(n.caps)
              ? n.caps.map(String).filter(Boolean).sort().join(", ")
              : "?";
            const paired = n.paired ? ok("paired") : warn("unpaired");
            const connected = n.connected ? ok("connected") : muted("disconnected");

            return {
              Node: name,
              ID: n.nodeId,
              IP: n.remoteIp ?? "",
              Device: device,
              Status: `${paired} · ${connected}`,
              Caps: caps,
            };
          });

          defaultRuntime.log(
            renderTable({
              width: tableWidth,
              columns: [
                { key: "Node", header: "Node", minWidth: 14, flex: true },
                { key: "ID", header: "ID", minWidth: 10 },
                { key: "IP", header: "IP", minWidth: 10 },
                { key: "Device", header: "Device", minWidth: 14, flex: true },
                { key: "Status", header: "Status", minWidth: 16 },
                { key: "Caps", header: "Caps", minWidth: 10, flex: true },
              ],
              rows,
            }).trimEnd(),
          );
        });
      }),
  );

  nodesCallOpts(
    nodes
      .command("describe")
      .description("Describe a node (capabilities + supported invoke commands)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("describe", async () => {
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          const result = (await callGatewayCli("node.describe", opts, {
            nodeId,
          })) as unknown;
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }

          const obj =
            typeof result === "object" && result !== null
              ? (result as Record<string, unknown>)
              : {};
          const displayName = typeof obj.displayName === "string" ? obj.displayName : nodeId;
          const connected = Boolean(obj.connected);
          const caps = Array.isArray(obj.caps) ? obj.caps.map(String).filter(Boolean).sort() : null;
          const commands = Array.isArray(obj.commands)
            ? obj.commands.map(String).filter(Boolean).sort()
            : [];
          const perms = formatPermissions(obj.permissions);
          const family = typeof obj.deviceFamily === "string" ? obj.deviceFamily : null;
          const model = typeof obj.modelIdentifier === "string" ? obj.modelIdentifier : null;
          const ip = typeof obj.remoteIp === "string" ? obj.remoteIp : null;
          const versions = formatNodeVersions(
            obj as {
              platform?: string;
              version?: string;
              coreVersion?: string;
              uiVersion?: string;
            },
          );

          const parts: string[] = ["Node:", displayName, nodeId];
          if (ip) parts.push(ip);
          if (family) parts.push(`device: ${family}`);
          if (model) parts.push(`hw: ${model}`);
          if (perms) parts.push(`perms: ${perms}`);
          if (versions) parts.push(versions);
          parts.push(connected ? "connected" : "disconnected");
          parts.push(`caps: ${caps ? `[${caps.join(",")}]` : "?"}`);
          defaultRuntime.log(parts.join(" · "));
          defaultRuntime.log("Commands:");
          if (commands.length === 0) {
            defaultRuntime.log("- (none reported)");
            return;
          }
          for (const c of commands) defaultRuntime.log(`- ${c}`);
        });
      }),
  );

  nodesCallOpts(
    nodes
      .command("list")
      .description("List pending and paired nodes")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("list", async () => {
          const result = (await callGatewayCli("node.pair.list", opts, {})) as unknown;
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          const { pending, paired } = parsePairingList(result);
          defaultRuntime.log(`Pending: ${pending.length} · Paired: ${paired.length}`);
          const rich = isRich();
          const heading = (text: string) => (rich ? theme.heading(text) : text);
          const muted = (text: string) => (rich ? theme.muted(text) : text);
          const warn = (text: string) => (rich ? theme.warn(text) : text);
          const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
          const now = Date.now();

          if (pending.length > 0) {
            const pendingRows = pending.map((r) => ({
              Request: r.requestId,
              Node: r.displayName?.trim() ? r.displayName.trim() : r.nodeId,
              IP: r.remoteIp ?? "",
              Requested:
                typeof r.ts === "number"
                  ? `${formatAge(Math.max(0, now - r.ts))} ago`
                  : muted("unknown"),
              Repair: r.isRepair ? warn("yes") : "",
            }));
            defaultRuntime.log("");
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
                rows: pendingRows,
              }).trimEnd(),
            );
          }

          if (paired.length > 0) {
            const pairedRows = paired.map((n) => ({
              Node: n.displayName?.trim() ? n.displayName.trim() : n.nodeId,
              Id: n.nodeId,
              IP: n.remoteIp ?? "",
              LastConnect:
                typeof n.lastConnectedAtMs === "number"
                  ? `${formatAge(Math.max(0, now - n.lastConnectedAtMs))} ago`
                  : muted("unknown"),
            }));
            defaultRuntime.log("");
            defaultRuntime.log(heading("Paired"));
            defaultRuntime.log(
              renderTable({
                width: tableWidth,
                columns: [
                  { key: "Node", header: "Node", minWidth: 14, flex: true },
                  { key: "Id", header: "ID", minWidth: 10 },
                  { key: "IP", header: "IP", minWidth: 10 },
                  { key: "LastConnect", header: "Last Connect", minWidth: 14 },
                ],
                rows: pairedRows,
              }).trimEnd(),
            );
          }
        });
      }),
  );
}
