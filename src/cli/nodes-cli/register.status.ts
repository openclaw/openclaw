import { formatByteSize } from "@openclaw/normalization-core";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { getTerminalTableWidth, renderTable } from "../../../packages/terminal-core/src/table.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { formatTimeAgo } from "../../infra/format-time/format-relative.ts";
import { defaultRuntime } from "../../runtime.js";
import { isNodeHostStats } from "../../shared/node-host-stats.js";
import { parseNodeList, parsePairingList } from "../../shared/node-list-parse.js";
import type { NodeListNode, PairedNode } from "../../shared/node-list-types.js";
import { shortenHomeInString } from "../../utils.js";
import { formatPairingApproveCommand } from "../pairing-command-format.js";
import { parseDurationMs } from "../parse-duration.js";
import { formatVersionLabel } from "../version-format.js";
import { formatConnectionFlagReminder, getNodesTheme, runNodesCommand } from "./cli-utils.js";
import { renderPendingPairingRequestsTable } from "./pairing-render.js";
import {
  callNodesGatewayCli,
  callNodeDiagnosticsGatewayCli,
  nodesCallOpts,
  resolveNodeDiagnosticsId,
} from "./rpc.js";
import type { NodesRpcOpts } from "./types.js";

type PairedNodeListRow = PairedNode & Partial<NodeListNode>;
type NodeApprovalState = NonNullable<NodeListNode["approvalState"]>;

/** Format node permission maps as a stable `[permission=yes|no]` label. */
function formatPermissions(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const entries = Object.entries(raw)
    .map(([key, value]) => [normalizeStringifiedOptionalString(key) ?? "", value === true] as const)
    .filter(([key]) => key.length > 0)
    .toSorted((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) {
    return null;
  }
  const parts = entries.map(([key, granted]) => `${key}=${granted ? "yes" : "no"}`);
  return `[${parts.join(", ")}]`;
}

function formatNodeStatsBytes(bytes: number): string {
  return formatByteSize(bytes, {
    style: "legacy-binary",
    maxUnit: "tera",
    separator: " ",
    fractionDigits: (value, unit) => (value < 10 && unit !== "byte" ? 1 : 0),
  });
}

function formatNodeHostStats(stats: unknown, connected: boolean, now: number): string | null {
  if (!isNodeHostStats(stats)) {
    return null;
  }
  const totalMemory = formatNodeStatsBytes(stats.memoryTotalBytes);
  const usedMemory = formatNodeStatsBytes(stats.memoryTotalBytes - stats.memoryFreeBytes);
  const memoryUnit = totalMemory.slice(totalMemory.lastIndexOf(" "));
  const usedLabel = usedMemory.endsWith(memoryUnit)
    ? usedMemory.slice(0, -memoryUnit.length)
    : usedMemory;
  const summary = [
    stats.loadAverage ? `load ${stats.loadAverage[0].toFixed(1)}/${stats.cpuCount}` : null,
    `mem ${usedLabel}/${totalMemory}`,
    stats.diskAvailableBytes !== undefined
      ? `disk ${formatNodeStatsBytes(stats.diskAvailableBytes)} free`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return connected
    ? summary
    : `${summary} (last known ${formatTimeAgo(Math.max(0, now - stats.updatedAtMs))})`;
}

function formatNodeVersions(
  node: Pick<NodeListNode, "platform" | "version" | "coreVersion" | "uiVersion">,
) {
  let core = normalizeOptionalString(node.coreVersion);
  let ui = normalizeOptionalString(node.uiVersion);
  if (!core && !ui) {
    const legacy = node.version?.trim();
    if (!legacy) {
      return null;
    }
    const platform = normalizeOptionalLowercaseString(node.platform);
    // Legacy nodes reported one version field; headless hosts use it as core, mobile nodes as UI.
    if (
      platform === "darwin" ||
      platform === "linux" ||
      platform === "win32" ||
      platform === "windows"
    ) {
      core = legacy;
    } else {
      ui = legacy;
    }
  }
  return (
    [core && `core ${formatVersionLabel(core)}`, ui && `ui ${formatVersionLabel(ui)}`]
      .filter(Boolean)
      .join(" · ") || null
  );
}

function formatPathEnv(raw?: string, platform?: string): string | null {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return null;
  }
  const normalizedPlatform = normalizeOptionalLowercaseString(platform);
  const delimiter = normalizedPlatform === "win32" || normalizedPlatform === "windows" ? ";" : ":";
  const parts = trimmed.split(delimiter).filter(Boolean);
  const display =
    parts.length <= 3
      ? trimmed
      : `${parts.slice(0, 2).join(delimiter)}${delimiter}…${delimiter}${parts.slice(-1)[0]}`;
  return shortenHomeInString(display);
}

function formatClientLabel(node: { clientId?: string; clientMode?: string }): string | null {
  return [node.clientId?.trim(), node.clientMode?.trim()].filter(Boolean).join("/") || null;
}

function formatNodeTerminalLabel(node: { nodeId: string; displayName?: string }): string {
  return sanitizeTerminalText(node.displayName?.trim() || node.nodeId);
}

function sortedNodeStrings(value: unknown): string[] | null {
  return Array.isArray(value) ? value.map(String).filter(Boolean).toSorted() : null;
}

function formatNodeTimeAgo(now: number, timestamp: unknown): string | null {
  return typeof timestamp === "number" && Number.isFinite(timestamp)
    ? formatTimeAgo(Math.max(0, now - timestamp))
    : null;
}

function formatNodeApprovalState(raw: unknown): NodeApprovalState | null {
  return raw === "approved" ||
    raw === "pending-approval" ||
    raw === "pending-reapproval" ||
    raw === "unapproved"
    ? raw
    : null;
}

function formatApprovalStateLabel(state: NodeApprovalState): string {
  if (state === "pending-approval") {
    return "approval pending";
  }
  if (state === "pending-reapproval") {
    return "reapproval pending";
  }
  return state;
}

function isPendingApprovalState(
  state: NodeApprovalState | null,
): state is "pending-approval" | "pending-reapproval" {
  return state === "pending-approval" || state === "pending-reapproval";
}

function parseSinceMs(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  try {
    return parseDurationMs(raw);
  } catch (err) {
    throw new Error(`Invalid --last-connected: ${formatErrorMessage(err)}`, { cause: err });
  }
}

function matchesNodeConnectionFilter(
  node: NodeListNode,
  connectedOnly: boolean,
  sinceMs: number | undefined,
  now: number,
): boolean {
  if (connectedOnly && !node.connected) {
    return false;
  }
  // Older gateways lack the recorded lastConnectedAtMs field.
  const lastConnectedAtMs = node.lastConnectedAtMs ?? node.connectedAtMs;
  return (
    sinceMs === undefined ||
    (typeof lastConnectedAtMs === "number" && now - lastConnectedAtMs <= sinceMs)
  );
}

function mergePairedNodeWithEffectiveNode(
  paired: PairedNode | undefined,
  effective: NodeListNode,
): PairedNodeListRow {
  return {
    ...paired,
    ...effective,
    createdAtMs: paired?.createdAtMs,
    // node.list can record a connection newer than the separate pairing snapshot.
    lastConnectedAtMs:
      effective.lastConnectedAtMs ?? paired?.lastConnectedAtMs ?? effective.connectedAtMs,
    displayName: effective.displayName ?? paired?.displayName,
    platform: effective.platform ?? paired?.platform,
    version: effective.version ?? paired?.version,
    coreVersion: effective.coreVersion ?? paired?.coreVersion,
    uiVersion: effective.uiVersion ?? paired?.uiVersion,
    remoteIp: effective.remoteIp ?? paired?.remoteIp,
    permissions: effective.permissions ?? paired?.permissions,
    approvedAtMs: effective.approvedAtMs ?? paired?.approvedAtMs,
  };
}

function mergePairedNodesWithEffectiveNodes(
  paired: PairedNode[],
  effectiveNodes: NodeListNode[] | null,
): PairedNodeListRow[] {
  if (effectiveNodes === null) {
    return paired;
  }
  const pairedById = new Map(paired.map((node) => [node.nodeId, node]));
  const seen = new Set<string>();
  const rows: PairedNodeListRow[] = [];
  for (const effective of effectiveNodes) {
    const pairedNode = pairedById.get(effective.nodeId);
    if (!pairedNode && effective.paired !== true) {
      continue;
    }
    seen.add(effective.nodeId);
    rows.push(mergePairedNodeWithEffectiveNode(pairedNode, effective));
  }
  for (const node of paired) {
    if (!seen.has(node.nodeId)) {
      rows.push(node);
    }
  }
  return rows;
}

async function tryReadNodeList(opts: NodesRpcOpts): Promise<NodeListNode[] | null> {
  try {
    return parseNodeList(await callNodeDiagnosticsGatewayCli("node.list", opts, {}));
  } catch (error) {
    // Best-effort enrichment may degrade to pairing-only rows, but never
    // silently: without this notice the table looks authoritative while
    // omitting connected/commands state. Stderr keeps --json output clean.
    defaultRuntime.error(
      getNodesTheme().muted(
        `live node view unavailable (${formatErrorMessage(error)}); showing paired-only data`,
      ),
    );
    return null;
  }
}

export function registerNodesStatusCommands(nodes: Command) {
  nodesCallOpts(
    nodes
      .command("status")
      .description("List known nodes with connection status and capabilities")
      .option("--connected", "Only show connected nodes")
      .option("--last-connected <duration>", "Only show nodes connected within duration (e.g. 24h)")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("status", async () => {
          const connectedOnly = Boolean(opts.connected);
          const sinceMs = parseSinceMs(opts.lastConnected);
          const result = await callNodeDiagnosticsGatewayCli("node.list", opts, {});
          const obj: Record<string, unknown> =
            typeof result === "object" && result !== null ? result : {};
          const { ok, warn, muted } = getNodesTheme();
          const tableWidth = getTerminalTableWidth();
          const now = Date.now();
          const nodesLocal = parseNodeList(result);
          const filtered = nodesLocal.filter((node) =>
            matchesNodeConnectionFilter(node, connectedOnly, sinceMs, now),
          );

          if (opts.json) {
            const ts = typeof obj.ts === "number" ? obj.ts : Date.now();
            defaultRuntime.writeJson({ ...obj, ts, nodes: filtered });
            return;
          }

          const pairedCount = filtered.filter((n) => Boolean(n.paired)).length;
          const connectedCount = filtered.filter((n) => Boolean(n.connected)).length;
          const filteredLabel =
            filtered.length !== nodesLocal.length ? ` (of ${nodesLocal.length})` : "";
          defaultRuntime.log(
            `Known: ${filtered.length}${filteredLabel} · Paired: ${pairedCount} · Connected: ${connectedCount}`,
          );
          if (filtered.length === 0) {
            return;
          }

          const rows = filtered.map((n) => {
            const perms = formatPermissions(n.permissions);
            const versions = formatNodeVersions(n);
            const pathEnv = formatPathEnv(n.pathEnv, n.platform);
            const client = formatClientLabel(n);
            const lastActive = formatNodeTimeAgo(now, n.lastActiveAtMs);
            const detailParts = [
              client ? `client: ${client}` : null,
              n.deviceFamily ? `device: ${n.deviceFamily}` : null,
              n.modelIdentifier ? `hw: ${n.modelIdentifier}` : null,
              perms ? `perms: ${perms}` : null,
              versions,
              formatNodeHostStats(n.hostStats, Boolean(n.connected), now),
              pathEnv ? `path: ${pathEnv}` : null,
              lastActive ? `input: ${lastActive}${n.active ? " (active)" : ""}` : null,
            ]
              .filter(Boolean)
              .map((part) => sanitizeTerminalText(String(part)));
            const caps = sortedNodeStrings(n.caps);
            const paired = n.paired ? ok("paired") : warn("unpaired");
            const connected = n.connected ? ok("connected") : muted("disconnected");
            const approvalState = formatNodeApprovalState(n.approvalState);
            const approval =
              approvalState === "approved"
                ? ok("approved")
                : isPendingApprovalState(approvalState)
                  ? warn(formatApprovalStateLabel(approvalState))
                  : approvalState === "unapproved"
                    ? warn("unapproved")
                    : null;
            const since =
              typeof n.connectedAtMs === "number"
                ? ` (${formatTimeAgo(Math.max(0, now - n.connectedAtMs))})`
                : "";

            return {
              Node: formatNodeTerminalLabel(n),
              ID: sanitizeTerminalText(n.nodeId),
              IP: sanitizeTerminalText(n.remoteIp ?? ""),
              Detail: detailParts.join(" · "),
              Status: `${paired} · ${connected}${since}${approval ? ` · ${approval}` : ""}`,
              Caps: caps ? sanitizeTerminalText(caps.join(", ")) : "?",
            };
          });

          defaultRuntime.log(
            renderTable({
              width: tableWidth,
              columns: [
                { key: "Node", header: "Node", minWidth: 14, flex: true },
                { key: "ID", header: "ID", minWidth: 10 },
                { key: "IP", header: "IP", minWidth: 10 },
                { key: "Detail", header: "Detail", minWidth: 18, flex: true },
                { key: "Status", header: "Status", minWidth: 18 },
                { key: "Caps", header: "Caps", minWidth: 12, flex: true },
              ],
              rows,
            }).trimEnd(),
          );
          for (const node of filtered) {
            const approvalState = formatNodeApprovalState(node.approvalState);
            const requestId = normalizeOptionalString(node.pendingRequestId);
            if (isPendingApprovalState(approvalState) && requestId) {
              const approveCommand = formatPairingApproveCommand("nodes", requestId, {
                timeout: opts.timeout,
              });
              const action = approvalState === "pending-reapproval" ? "Reapproval" : "Approval";
              defaultRuntime.log(
                warn(
                  `${action} pending for ${formatNodeTerminalLabel(node)}. Run ${sanitizeTerminalText(approveCommand)}`,
                ),
              );
              const connectionReminder = formatConnectionFlagReminder(opts);
              if (connectionReminder) {
                defaultRuntime.log(warn(connectionReminder));
              }
            }
          }
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
          const nodeId = await resolveNodeDiagnosticsId(opts, opts.node ?? "");
          const result = await callNodeDiagnosticsGatewayCli("node.describe", opts, {
            nodeId,
          });
          if (opts.json) {
            defaultRuntime.writeJson(result);
            return;
          }

          const obj: Record<string, unknown> =
            typeof result === "object" && result !== null ? result : {};
          const displayName = typeof obj.displayName === "string" ? obj.displayName : nodeId;
          const connected = Boolean(obj.connected);
          const paired = Boolean(obj.paired);
          const caps = sortedNodeStrings(obj.caps);
          const commands = sortedNodeStrings(obj.commands) ?? [];
          const perms = formatPermissions(obj.permissions);
          const approvalState = formatNodeApprovalState(obj.approvalState);
          const pendingRequestId = normalizeOptionalString(obj.pendingRequestId);
          const pendingCaps = sortedNodeStrings(obj.pendingDeclaredCaps);
          const pendingCommands = sortedNodeStrings(obj.pendingDeclaredCommands) ?? [];
          const pendingPerms = formatPermissions(obj.pendingDeclaredPermissions);
          const approveCommand =
            isPendingApprovalState(approvalState) && pendingRequestId
              ? formatPairingApproveCommand("nodes", pendingRequestId, { timeout: opts.timeout })
              : null;
          const connectionReminder = approveCommand ? formatConnectionFlagReminder(opts) : null;
          const family = typeof obj.deviceFamily === "string" ? obj.deviceFamily : null;
          const model = typeof obj.modelIdentifier === "string" ? obj.modelIdentifier : null;
          const client = formatClientLabel(obj as { clientId?: string; clientMode?: string });
          const ip = typeof obj.remoteIp === "string" ? obj.remoteIp : null;
          const pathEnv = typeof obj.pathEnv === "string" ? obj.pathEnv : null;
          const versions = formatNodeVersions(obj as Parameters<typeof formatNodeVersions>[0]);
          const lastActive = formatNodeTimeAgo(Date.now(), obj.lastActiveAtMs);
          const stats = formatNodeHostStats(obj.hostStats, connected, Date.now());

          const { heading, ok, warn, muted } = getNodesTheme();
          const status = `${paired ? ok("paired") : warn("unpaired")} · ${
            connected ? ok("connected") : muted("disconnected")
          }`;
          const tableWidth = getTerminalTableWidth();
          const rows = [{ Field: "ID", Value: sanitizeTerminalText(nodeId) }];
          const addDetail = (field: string, value: string | null) => {
            if (value) {
              rows.push({ Field: field, Value: sanitizeTerminalText(value) });
            }
          };
          addDetail("Name", displayName);
          addDetail("Client", client);
          addDetail("IP", ip);
          addDetail("Device", family);
          addDetail("Model", model);
          addDetail("Perms", perms);
          addDetail("Version", versions);
          addDetail("Stats", stats);
          addDetail("PATH", pathEnv);
          addDetail(
            "Last input",
            lastActive ? `${lastActive}${obj.active === true ? " (active node)" : ""}` : null,
          );
          rows.push({ Field: "Status", Value: status });
          addDetail("Approval", approvalState ? formatApprovalStateLabel(approvalState) : null);
          addDetail("Pending request", pendingRequestId ?? null);
          // An empty reported capability list remains a visible row.
          if (pendingCaps) {
            rows.push({
              Field: "Pending caps",
              Value: sanitizeTerminalText(pendingCaps.join(", ")),
            });
          }
          addDetail("Pending perms", pendingPerms);
          addDetail(
            approvalState === "pending-reapproval" ? "Reapprove" : "Approve",
            approveCommand,
          );
          addDetail("Connection reminder", approveCommand && connectionReminder);
          rows.push({ Field: "Caps", Value: caps ? sanitizeTerminalText(caps.join(", ")) : "?" });

          defaultRuntime.log(heading("Node"));
          defaultRuntime.log(
            renderTable({
              width: tableWidth,
              columns: [
                { key: "Field", header: "Field", minWidth: 8 },
                { key: "Value", header: "Value", minWidth: 24, flex: true },
              ],
              rows,
            }).trimEnd(),
          );
          defaultRuntime.log("");
          defaultRuntime.log(heading("Commands"));
          if (commands.length === 0) {
            defaultRuntime.log(muted("- (none effective)"));
          } else {
            for (const c of commands) {
              defaultRuntime.log(`- ${sanitizeTerminalText(c)}`);
            }
          }
          if (pendingCommands.length > 0) {
            defaultRuntime.log("");
            defaultRuntime.log(heading("Pending commands"));
            for (const command of pendingCommands) {
              defaultRuntime.log(`- ${sanitizeTerminalText(command)}`);
            }
          }
        });
      }),
  );

  nodesCallOpts(
    nodes
      .command("list")
      .description("List pending and paired nodes")
      .option("--connected", "Only show connected nodes")
      .option("--last-connected <duration>", "Only show nodes connected within duration (e.g. 24h)")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("list", async () => {
          const connectedOnly = Boolean(opts.connected);
          const sinceMs = parseSinceMs(opts.lastConnected);
          const result = await callNodesGatewayCli("node.pair.list", opts, {});
          const { pending, paired } = parsePairingList(result);
          const { heading, muted } = getNodesTheme();
          const tableWidth = getTerminalTableWidth();
          const now = Date.now();
          const hasFilters = connectedOnly || sinceMs !== undefined;
          // Pending requests carry no connection state to filter on; hiding
          // them under --connected printed "Pending: 0" while requests waited.
          const effectiveNodes = hasFilters
            ? parseNodeList(await callNodeDiagnosticsGatewayCli("node.list", opts, {}))
            : await tryReadNodeList(opts);
          const effectivePairedRows = mergePairedNodesWithEffectiveNodes(paired, effectiveNodes);
          const filteredPaired = effectivePairedRows.filter((node) =>
            matchesNodeConnectionFilter(node, connectedOnly, sinceMs, now),
          );
          const filteredLabel =
            hasFilters && filteredPaired.length !== effectivePairedRows.length
              ? ` (of ${effectivePairedRows.length})`
              : "";
          if (opts.json) {
            defaultRuntime.writeJson({
              pending,
              // Current gateways emit no token, but the permissive parser keeps
              // unknown fields; strip so an older gateway's legacy node token
              // never reaches JSON output.
              paired: filteredPaired.map((row) => {
                const { token: _token, ...rest } = row as { token?: unknown };
                return rest;
              }),
            });
            return;
          }

          defaultRuntime.log(
            `Pending: ${pending.length} · Paired: ${filteredPaired.length}${filteredLabel}`,
          );

          if (pending.length > 0) {
            const rendered = renderPendingPairingRequestsTable({
              pending,
              now,
              tableWidth,
              theme: { heading, muted },
            });
            defaultRuntime.log("");
            defaultRuntime.log(rendered.heading);
            defaultRuntime.log(rendered.table);
          }

          if (filteredPaired.length > 0) {
            const pairedTableRows = filteredPaired.map((n) => ({
              Node: formatNodeTerminalLabel(n),
              Id: sanitizeTerminalText(n.nodeId),
              IP: sanitizeTerminalText(n.remoteIp ?? ""),
              LastConnect:
                formatNodeTimeAgo(now, n.lastConnectedAtMs ?? n.connectedAtMs) ?? muted("unknown"),
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
                rows: pairedTableRows,
              }).trimEnd(),
            );
          }
        });
      }),
  );
}
