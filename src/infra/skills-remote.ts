import type { SkillEligibilityContext, SkillEntry } from "../agents/skills.js";
import { loadWorkspaceSkillEntries } from "../agents/skills.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { ClawdbotConfig } from "../config/config.js";
import type { NodeBridgeServer } from "./bridge/server.js";
import { listNodePairing, updatePairedNodeMetadata } from "./node-pairing.js";
import { createSubsystemLogger } from "../logging.js";
import { bumpSkillsSnapshotVersion } from "../agents/skills/refresh.js";

type RemoteNodeRecord = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  deviceFamily?: string;
  commands?: string[];
  bins: Set<string>;
};

const log = createSubsystemLogger("gateway/skills-remote");
const remoteNodes = new Map<string, RemoteNodeRecord>();
let remoteBridge: NodeBridgeServer | null = null;

function isMacPlatform(platform?: string, deviceFamily?: string): boolean {
  const platformNorm = String(platform ?? "")
    .trim()
    .toLowerCase();
  const familyNorm = String(deviceFamily ?? "")
    .trim()
    .toLowerCase();
  if (platformNorm.includes("mac")) return true;
  if (platformNorm.includes("darwin")) return true;
  if (familyNorm === "mac") return true;
  return false;
}

function supportsSystemRun(commands?: string[]): boolean {
  return Array.isArray(commands) && commands.includes("system.run");
}

function supportsSystemWhich(commands?: string[]): boolean {
  return Array.isArray(commands) && commands.includes("system.which");
}

function upsertNode(record: {
  nodeId: string;
  displayName?: string;
  platform?: string;
  deviceFamily?: string;
  commands?: string[];
  bins?: string[];
}) {
  const existing = remoteNodes.get(record.nodeId);
  const bins = new Set<string>(record.bins ?? existing?.bins ?? []);
  remoteNodes.set(record.nodeId, {
    nodeId: record.nodeId,
    displayName: record.displayName ?? existing?.displayName,
    platform: record.platform ?? existing?.platform,
    deviceFamily: record.deviceFamily ?? existing?.deviceFamily,
    commands: record.commands ?? existing?.commands,
    bins,
  });
}

export function setSkillsRemoteBridge(bridge: NodeBridgeServer | null) {
  remoteBridge = bridge;
}

export async function primeRemoteSkillsCache() {
  try {
    const list = await listNodePairing();
    let sawMac = false;
    for (const node of list.paired) {
      upsertNode({
        nodeId: node.nodeId,
        displayName: node.displayName,
        platform: node.platform,
        deviceFamily: node.deviceFamily,
        commands: node.commands,
        bins: node.bins,
      });
      if (isMacPlatform(node.platform, node.deviceFamily) && supportsSystemRun(node.commands)) {
        sawMac = true;
      }
    }
    if (sawMac) {
      bumpSkillsSnapshotVersion({ reason: "remote-node" });
    }
  } catch (err) {
    log.warn(`failed to prime remote skills cache: ${String(err)}`);
  }
}

export function recordRemoteNodeInfo(node: {
  nodeId: string;
  displayName?: string;
  platform?: string;
  deviceFamily?: string;
  commands?: string[];
}) {
  upsertNode(node);
}

export function recordRemoteNodeBins(nodeId: string, bins: string[]) {
  upsertNode({ nodeId, bins });
}

function listWorkspaceDirs(cfg: ClawdbotConfig): string[] {
  const dirs = new Set<string>();
  const list = cfg.agents?.list;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (entry && typeof entry === "object" && typeof entry.id === "string") {
        dirs.add(resolveAgentWorkspaceDir(cfg, entry.id));
      }
    }
  }
  dirs.add(resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)));
  return [...dirs];
}

function collectRequiredBins(entries: SkillEntry[], targetPlatform: string): string[] {
  const bins = new Set<string>();
  for (const entry of entries) {
    const os = entry.clawdbot?.os ?? [];
    if (os.length > 0 && !os.includes(targetPlatform)) continue;
    const required = entry.clawdbot?.requires?.bins ?? [];
    const anyBins = entry.clawdbot?.requires?.anyBins ?? [];
    for (const bin of required) {
      if (bin.trim()) bins.add(bin.trim());
    }
    for (const bin of anyBins) {
      if (bin.trim()) bins.add(bin.trim());
    }
  }
  return [...bins];
}

function buildBinProbeScript(bins: string[]): string {
  const escaped = bins.map((bin) => `'${bin.replace(/'/g, `'\\''`)}'`).join(" ");
  return `for b in ${escaped}; do if command -v "$b" >/dev/null 2>&1; then echo "$b"; fi; done`;
}

function parseBinProbePayload(payloadJSON: string | null | undefined): string[] {
  if (!payloadJSON) return [];
  try {
    const parsed = JSON.parse(payloadJSON) as { stdout?: unknown; bins?: unknown };
    if (Array.isArray(parsed.bins)) {
      return parsed.bins.map((bin) => String(bin).trim()).filter(Boolean);
    }
    if (typeof parsed.stdout === "string") {
      return parsed.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    }
  } catch {
    return [];
  }
  return [];
}

export async function refreshRemoteNodeBins(params: {
  nodeId: string;
  platform?: string;
  deviceFamily?: string;
  commands?: string[];
  cfg: ClawdbotConfig;
  timeoutMs?: number;
}) {
  if (!remoteBridge) return;
  if (!isMacPlatform(params.platform, params.deviceFamily)) return;
  const canWhich = supportsSystemWhich(params.commands);
  const canRun = supportsSystemRun(params.commands);
  if (!canWhich && !canRun) return;

  const workspaceDirs = listWorkspaceDirs(params.cfg);
  const requiredBins = new Set<string>();
  for (const workspaceDir of workspaceDirs) {
    const entries = loadWorkspaceSkillEntries(workspaceDir, { config: params.cfg });
    for (const bin of collectRequiredBins(entries, "darwin")) {
      requiredBins.add(bin);
    }
  }
  if (requiredBins.size === 0) return;

  try {
    const binsList = [...requiredBins];
    const res = await remoteBridge.invoke(
      canWhich
        ? {
            nodeId: params.nodeId,
            command: "system.which",
            paramsJSON: JSON.stringify({ bins: binsList }),
            timeoutMs: params.timeoutMs ?? 15_000,
          }
        : {
            nodeId: params.nodeId,
            command: "system.run",
            paramsJSON: JSON.stringify({
              command: ["/bin/sh", "-lc", buildBinProbeScript(binsList)],
            }),
            timeoutMs: params.timeoutMs ?? 15_000,
          },
    );
    if (!res.ok) {
      log.warn(`remote bin probe failed (${params.nodeId}): ${res.error?.message ?? "unknown"}`);
      return;
    }
    const bins = parseBinProbePayload(res.payloadJSON);
    recordRemoteNodeBins(params.nodeId, bins);
    await updatePairedNodeMetadata(params.nodeId, { bins });
    bumpSkillsSnapshotVersion({ reason: "remote-node" });
  } catch (err) {
    log.warn(`remote bin probe error (${params.nodeId}): ${String(err)}`);
  }
}

export function getRemoteSkillEligibility(): SkillEligibilityContext["remote"] | undefined {
  const macNodes = [...remoteNodes.values()].filter(
    (node) => isMacPlatform(node.platform, node.deviceFamily) && supportsSystemRun(node.commands),
  );
  if (macNodes.length === 0) return undefined;
  const bins = new Set<string>();
  for (const node of macNodes) {
    for (const bin of node.bins) bins.add(bin);
  }
  const labels = macNodes.map((node) => node.displayName ?? node.nodeId).filter(Boolean);
  const note =
    labels.length > 0
      ? `Remote macOS node available (${labels.join(", ")}). Run macOS-only skills via nodes.run on that node.`
      : "Remote macOS node available. Run macOS-only skills via nodes.run on that node.";
  return {
    platforms: ["darwin"],
    hasBin: (bin) => bins.has(bin),
    hasAnyBin: (required) => required.some((bin) => bins.has(bin)),
    note,
  };
}

export async function refreshRemoteBinsForConnectedNodes(cfg: ClawdbotConfig) {
  if (!remoteBridge) return;
  const connected = remoteBridge.listConnected();
  for (const node of connected) {
    await refreshRemoteNodeBins({
      nodeId: node.nodeId,
      platform: node.platform,
      deviceFamily: node.deviceFamily,
      commands: node.commands,
      cfg,
    });
  }
}
