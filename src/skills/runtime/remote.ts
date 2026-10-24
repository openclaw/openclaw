import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  normalizeStringEntries,
  normalizeUniqueStringEntries,
} from "@openclaw/normalization-core/string-normalization";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { NodeRegistry } from "../../gateway/node-registry.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import { updatePairedNodeBins } from "../../infra/device-pairing-node-facts.js";
import { listNodePairing } from "../../infra/device-pairing-node.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isOsRequirementSatisfied } from "../../shared/requirements.js";
import type { SkillEligibilityContext, SkillEntry } from "../types.js";
import { bumpSkillsSnapshotVersion } from "./refresh-state.js";
import {
  recordRemoteSkillNodeInfo,
  remoteConnectionKey,
  removeRemoteNodeSkills,
  setRemoteSkillConnectionReconciler,
} from "./remote-skills.js";

type RemoteNodeRecord = {
  nodeId: string;
  connId?: string;
  displayName?: string;
  platform?: string;
  deviceFamily?: string;
  commands?: string[];
  bins: Set<string>;
  pairingGeneration?: string;
  connected: boolean;
  remoteIp?: string;
};

type RemoteNodeProbeState = {
  signature: string;
  pairingGeneration: string;
  nextProbeAfterMs: number;
  failedProbeCount: number;
  bins?: Set<string>;
};

const log = createSubsystemLogger("gateway/skills-remote");
const remoteNodes = new Map<string, RemoteNodeRecord>();
const remoteNodeProbeStates = new Map<string, RemoteNodeProbeState>();
type RemoteNodeOwner = {
  connId?: string;
  pairingGeneration: string;
};
type RemoteBinProbeInflight = RemoteNodeOwner & {
  promise: Promise<void>;
};

const remoteBinProbeInflight = new Map<string, RemoteBinProbeInflight>();
let remoteRegistry: NodeRegistry | null = null;
const REMOTE_BIN_PROBE_SUCCESS_TTL_MS = 30 * 60 * 1000;
const REMOTE_BIN_PROBE_FAILURE_BASE_BACKOFF_MS = 15_000;
const REMOTE_BIN_PROBE_FAILURE_MAX_BACKOFF_MS = 5 * 60 * 1000;

function extractErrorMessage(err: unknown): string | undefined {
  if (!err) {
    return undefined;
  }
  if (err instanceof Error || (typeof err !== "object" && typeof err !== "function")) {
    return coerceErrorMessage(err);
  }
  if (typeof err !== "object") {
    return undefined;
  }
  if ("message" in err && typeof err.message === "string") {
    return err.message;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return undefined;
  }
}

function isMacPlatform(platform?: string, deviceFamily?: string): boolean {
  const platformNorm = normalizeLowercaseStringOrEmpty(platform);
  const familyNorm = normalizeLowercaseStringOrEmpty(deviceFamily);
  return platformNorm.includes("mac") || platformNorm.includes("darwin") || familyNorm === "mac";
}

function supportsSystemRun(commands?: string[]): boolean {
  return commands?.includes("system.run") ?? false;
}

function isRemoteSkillEligibilityNode(
  node:
    | {
        connected?: boolean;
        platform?: string;
        deviceFamily?: string;
        commands?: string[];
      }
    | undefined,
): boolean {
  return Boolean(
    node?.connected &&
    isMacPlatform(node.platform, node.deviceFamily) &&
    supportsSystemRun(node.commands),
  );
}

function collectRequiredBins(entries: SkillEntry[], targetPlatform: string): string[] {
  return normalizeUniqueStringEntries(
    entries.flatMap(({ metadata }) =>
      !isOsRequirementSatisfied(metadata?.os ?? [], [targetPlatform])
        ? []
        : [...(metadata?.requires?.bins ?? []), ...(metadata?.requires?.anyBins ?? [])],
    ),
  );
}

function buildBinProbeScript(bins: string[]): string {
  const escaped = bins.map((bin) => `'${bin.replace(/'/g, `'\\''`)}'`).join(" ");
  return `for b in ${escaped}; do if command -v "$b" >/dev/null 2>&1; then echo "$b"; fi; done`;
}

function parseBinProbePayload(payloadJSON: string | null | undefined, payload?: unknown): string[] {
  if (!payloadJSON && !payload) {
    return [];
  }
  try {
    // SAFETY: Fields stay unknown until narrowed below; malformed payloads reach catch.
    const parsed = (payloadJSON ? JSON.parse(payloadJSON) : payload) as {
      stdout?: unknown;
      bins?: unknown;
    };
    if (Array.isArray(parsed.bins)) {
      return normalizeStringEntries(parsed.bins);
    }
    if (parsed.bins && typeof parsed.bins === "object") {
      return Object.entries(parsed.bins)
        .filter(([, resolvedPath]) => normalizeOptionalString(resolvedPath) !== undefined)
        .map(([bin]) => normalizeOptionalString(bin) ?? "")
        .filter(Boolean);
    }
    if (typeof parsed.stdout === "string") {
      return normalizeStringEntries(parsed.stdout.split(/\r?\n/));
    }
  } catch {
    return [];
  }
  return [];
}

function areBinSetsEqual(a: Set<string> | undefined, b: Set<string>): boolean {
  if (!a || a.size !== b.size) {
    return false;
  }
  for (const bin of b) {
    if (!a.has(bin)) {
      return false;
    }
  }
  return true;
}

function describeNode(nodeId: string): string {
  const record = remoteNodes.get(nodeId);
  const name = record?.displayName?.trim();
  const base = name && name !== nodeId ? `${name} (${nodeId})` : nodeId;
  const ip = record?.remoteIp?.trim();
  return ip ? `${base} @ ${ip}` : base;
}

type RemoteBinProbeLogContext = {
  command: string;
  timeoutMs: number;
  requiredBinCount: number;
};

function logRemoteBinProbeFailure(
  nodeId: string,
  err: unknown,
  context: RemoteBinProbeLogContext,
  phase: "preflight" | "probe" = "probe",
) {
  const message = extractErrorMessage(err);
  const label = describeNode(nodeId);
  const details = `command=${context.command} timeoutMs=${context.timeoutMs} requiredBins=${context.requiredBinCount} connected=${remoteNodes.get(nodeId)?.connected === true ? "yes" : "no"}`;
  if (phase === "preflight") {
    log.info(
      `remote bin check skipped: node connectivity unavailable (${label}; ${details}): ${
        message ?? "unknown"
      }`,
    );
    return;
  }
  // Node unavailable errors (not connected or disconnected mid-operation) are expected
  // when nodes have transient connections - log at info level instead of warn
  if (message?.includes("node not connected") || message?.includes("node disconnected")) {
    log.info(`remote bin check skipped: node unavailable (${label}; ${details})`);
    return;
  }
  if (message?.includes("invoke timed out") || message?.includes("timeout")) {
    log.warn(
      `remote bin check timed out (${label}; ${details}); check node connectivity for ${label}`,
    );
    return;
  }
  log.warn(`remote bin check error (${label}; ${details}): ${message ?? "unknown"}`);
}

function upsertNode(
  record: Omit<RemoteNodeRecord, "bins" | "connected"> & {
    bins?: string[];
    connected?: boolean;
  },
  options?: { pairingGenerationAuthoritative?: boolean },
) {
  const existing = remoteNodes.get(record.nodeId);
  const pairingGeneration = options?.pairingGenerationAuthoritative
    ? record.pairingGeneration
    : (record.pairingGeneration ?? existing?.pairingGeneration);
  const pairingGenerationChanged = Boolean(
    options?.pairingGenerationAuthoritative &&
    existing &&
    existing.pairingGeneration !== record.pairingGeneration,
  );
  const bins = new Set<string>(
    record.bins ?? (pairingGenerationChanged ? [] : (existing?.bins ?? [])),
  );
  remoteNodes.set(record.nodeId, {
    nodeId: record.nodeId,
    connId: record.connId ?? existing?.connId,
    displayName: record.displayName ?? existing?.displayName,
    platform: record.platform ?? existing?.platform,
    deviceFamily: record.deviceFamily ?? existing?.deviceFamily,
    commands: record.commands ?? existing?.commands,
    remoteIp: record.remoteIp ?? existing?.remoteIp,
    bins,
    ...(pairingGeneration ? { pairingGeneration } : {}),
    connected: record.connected ?? existing?.connected ?? false,
  });
}

function isCurrentRemoteNodeOwner(nodeId: string, owner: RemoteNodeOwner): boolean {
  const current = remoteNodes.get(nodeId);
  return Boolean(
    current &&
    current.pairingGeneration === owner.pairingGeneration &&
    (!owner.connId || !current.connId || current.connId === owner.connId),
  );
}

function listCurrentRemoteConnectionKeys(): ReadonlySet<string> | undefined {
  if (!remoteRegistry) {
    return undefined;
  }
  return new Set(
    remoteRegistry
      .listCurrentConnectedSync()
      .map((node) => remoteConnectionKey(node.nodeId, node.connId)),
  );
}

export function setSkillsRemoteRegistry(registry: NodeRegistry | null) {
  remoteRegistry = registry;
  setRemoteSkillConnectionReconciler(
    registry ? listCurrentRemoteConnectionKeys : null,
    registry ? () => registry.listCurrentConnected() : undefined,
  );
  if (!registry) {
    remoteNodeProbeStates.clear();
  }
}

export async function primeRemoteSkillsCache() {
  try {
    const { paired } = await listNodePairing(undefined, { includePairingGeneration: true });
    let sawMac = false;
    for (const node of paired) {
      if (!node.pairingGeneration) {
        continue;
      }
      upsertNode(
        {
          nodeId: node.nodeId,
          displayName: node.displayName,
          platform: node.platform,
          deviceFamily: node.deviceFamily,
          commands: node.commands,
          remoteIp: node.remoteIp,
          bins: node.bins,
          pairingGeneration: node.pairingGeneration,
          connected: false,
        },
        { pairingGenerationAuthoritative: true },
      );
      if (
        node.bins?.length &&
        isMacPlatform(node.platform, node.deviceFamily) &&
        supportsSystemRun(node.commands)
      ) {
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

export function recordRemoteNodeInfo(node: Omit<RemoteNodeRecord, "bins" | "connected">) {
  const existing = remoteNodes.get(node.nodeId);
  const wasEligible = isRemoteSkillEligibilityNode(existing);
  const pairingGenerationChanged = Boolean(
    existing && existing.pairingGeneration !== node.pairingGeneration,
  );
  if (
    pairingGenerationChanged ||
    (node.connId &&
      existing?.connId !== node.connId &&
      !remoteNodeProbeStates.get(node.nodeId)?.bins)
  ) {
    remoteNodeProbeStates.delete(node.nodeId);
  }
  upsertNode({ ...node, connected: true }, { pairingGenerationAuthoritative: true });
  if (wasEligible !== isRemoteSkillEligibilityNode(remoteNodes.get(node.nodeId))) {
    // Connectivity and command-surface changes affect OS-only skills even before
    // the delayed bin probe; the probe emits a second invalidation if bins change.
    bumpSkillsSnapshotVersion({ reason: "remote-node" });
  }
  recordRemoteSkillNodeInfo(node);
}

export function recordRemoteNodeBins(nodeId: string, bins: string[], pairingGeneration: string) {
  upsertNode({ nodeId, bins, pairingGeneration });
}

export function removeRemoteNodeInfo(nodeId: string) {
  const existing = remoteNodes.get(nodeId);
  remoteNodes.delete(nodeId);
  removeRemoteNodeSkills(nodeId);
  const probeState = remoteNodeProbeStates.get(nodeId);
  if (probeState && !probeState.bins) {
    // A new connection is a new recovery opportunity. Keep successful bin
    // snapshots across reconnects, but never carry failure backoff forward.
    remoteNodeProbeStates.delete(nodeId);
  }
  if (
    existing &&
    isMacPlatform(existing.platform, existing.deviceFamily) &&
    supportsSystemRun(existing.commands)
  ) {
    bumpSkillsSnapshotVersion({ reason: "remote-node" });
  }
}

/** Remove remote projections only while they still belong to the invalidated connection. */
export function removeRemoteNodeInfoForConnection(nodeId: string, connId: string): boolean {
  if (remoteNodes.get(nodeId)?.connId !== connId) {
    return false;
  }
  removeRemoteNodeInfo(nodeId);
  return true;
}

type RemoteNodeBinRefreshParams = {
  nodeId: string;
  platform?: string;
  deviceFamily?: string;
  commands?: string[];
  cfg: OpenClawConfig;
  readinessDelayMs?: number;
  readinessSignal?: AbortSignal;
};

export async function refreshRemoteNodeBins(params: RemoteNodeBinRefreshParams): Promise<void> {
  for (;;) {
    const session = remoteRegistry?.get(params.nodeId);
    if (!session?.pairingGeneration) {
      return;
    }
    const owner: RemoteNodeOwner = {
      connId: session.connId,
      pairingGeneration: session.pairingGeneration,
    };
    const existing = remoteBinProbeInflight.get(params.nodeId);
    if (existing) {
      await existing.promise;
      if (
        existing.connId === owner.connId &&
        existing.pairingGeneration === owner.pairingGeneration
      ) {
        return;
      }
      // Replacement waiters resume together. Recheck the live owner and map
      // before starting another probe so they stay coalesced.
      continue;
    }
    const run = refreshRemoteNodeBinsUncoalesced(params).finally(() => {
      remoteBinProbeInflight.delete(params.nodeId);
    });
    remoteBinProbeInflight.set(params.nodeId, { ...owner, promise: run });
    await run;
    return;
  }
}

async function refreshRemoteNodeBinsUncoalesced(params: RemoteNodeBinRefreshParams) {
  const readinessDelayMs = params.readinessDelayMs ?? 0;
  if (readinessDelayMs > 0) {
    try {
      await sleepWithAbort(readinessDelayMs, params.readinessSignal);
    } catch (error) {
      if (!params.readinessSignal?.aborted) {
        throw error;
      }
    }
  }
  // Retire an idle connect probe on shutdown; started probes still finish below.
  if (params.readinessSignal?.aborted) {
    return;
  }
  if (!remoteRegistry) {
    return;
  }
  const { prepareWorkspaceSkillEntries } = await import("../loading/workspace-skill-loader.js");
  // Pairing can replace the command surface while the connect-time readiness
  // delay or loader import is pending. Probe the live session after both settle.
  const liveSession = remoteRegistry?.get(params.nodeId);
  if (params.readinessSignal?.aborted || !liveSession?.pairingGeneration) {
    return;
  }
  const probeOwner: RemoteNodeOwner = {
    connId: liveSession.connId,
    pairingGeneration: liveSession.pairingGeneration,
  };
  const platform = liveSession.platform ?? params.platform;
  const deviceFamily = liveSession.deviceFamily ?? params.deviceFamily;
  const commands = liveSession.commands ?? params.commands;
  if (!isMacPlatform(platform, deviceFamily)) {
    return;
  }
  const canWhich = commands?.includes("system.which") ?? false;
  const canRun = supportsSystemRun(commands);
  if (!canWhich && !canRun) {
    return;
  }

  const requiredBins = new Set<string>();
  for (const agentId of listAgentIds(params.cfg)) {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
    // Probe prerequisites before host eligibility can hide remote-only skills.
    const { entries } = await prepareWorkspaceSkillEntries(workspaceDir, {
      config: params.cfg,
      agentId,
      agentSkillFilter: "ignore",
    });
    if (params.readinessSignal?.aborted || !isCurrentRemoteNodeOwner(params.nodeId, probeOwner)) {
      return;
    }
    for (const bin of collectRequiredBins(entries, "darwin")) {
      requiredBins.add(bin);
    }
  }
  if (requiredBins.size === 0) {
    return;
  }

  const binsList = [...requiredBins];
  const timeoutMs = 15_000;
  const command = canWhich ? "system.which" : "system.run";
  const probeSignature = JSON.stringify([
    command,
    normalizeLowercaseStringOrEmpty(platform),
    normalizeLowercaseStringOrEmpty(deviceFamily),
    (commands ?? []).toSorted(),
    binsList.toSorted(),
  ]);
  const cachedProbe = remoteNodeProbeStates.get(params.nodeId);
  if (
    cachedProbe?.pairingGeneration === probeOwner.pairingGeneration &&
    cachedProbe.signature === probeSignature &&
    Date.now() < cachedProbe.nextProbeAfterMs
  ) {
    const node = remoteNodes.get(params.nodeId);
    if (
      node &&
      cachedProbe.pairingGeneration === node.pairingGeneration &&
      cachedProbe.bins &&
      !areBinSetsEqual(node.bins, cachedProbe.bins)
    ) {
      node.bins = new Set(cachedProbe.bins);
      bumpSkillsSnapshotVersion({ reason: "remote-node" });
    }
    return;
  }
  const logContext = { command, timeoutMs, requiredBinCount: binsList.length };
  const recordFailure = (
    error: unknown,
    context: RemoteBinProbeLogContext = logContext,
    phase?: "preflight" | "probe",
  ) => {
    const nodeId = params.nodeId;
    const nowMs = Date.now();
    if (!isCurrentRemoteNodeOwner(nodeId, probeOwner)) {
      return;
    }
    const existing = remoteNodeProbeStates.get(nodeId);
    const failedProbeCount =
      existing?.signature === probeSignature ? existing.failedProbeCount + 1 : 1;
    const backoffMs = Math.min(
      REMOTE_BIN_PROBE_FAILURE_MAX_BACKOFF_MS,
      REMOTE_BIN_PROBE_FAILURE_BASE_BACKOFF_MS * 2 ** (failedProbeCount - 1),
    );
    remoteNodeProbeStates.set(nodeId, {
      signature: probeSignature,
      pairingGeneration: probeOwner.pairingGeneration,
      nextProbeAfterMs: nowMs + backoffMs,
      failedProbeCount,
    });
    const node = remoteNodes.get(nodeId);
    const cleared = Boolean(node?.bins.size);
    if (node && cleared) {
      node.bins = new Set();
    }
    logRemoteBinProbeFailure(nodeId, error, context, phase);
    if (cleared) {
      bumpSkillsSnapshotVersion({ reason: "remote-node" });
    }
  };
  if (typeof remoteRegistry.checkConnectivity === "function") {
    const preflightContext = {
      command: "websocket.ping",
      timeoutMs: 2_000,
      requiredBinCount: binsList.length,
    };
    const preflightConnId = remoteRegistry.get(params.nodeId)?.connId;
    let connectivity: Awaited<ReturnType<typeof remoteRegistry.checkConnectivity>>;
    try {
      connectivity = await remoteRegistry.checkConnectivity(params.nodeId, 2_000);
    } catch (err) {
      recordFailure(err, preflightContext, "preflight");
      return;
    }
    if (!connectivity.ok) {
      const latestSession = remoteRegistry.get(params.nodeId);
      if (preflightConnId && latestSession && latestSession.connId !== preflightConnId) {
        await refreshRemoteNodeBinsUncoalesced({
          nodeId: latestSession.nodeId,
          platform: latestSession.platform,
          deviceFamily: latestSession.deviceFamily,
          commands: latestSession.commands,
          cfg: params.cfg,
        });
        return;
      }
      recordFailure(connectivity.error.message, preflightContext, "preflight");
      return;
    }
  }
  try {
    const res = await remoteRegistry.invoke({
      nodeId: params.nodeId,
      expectedPairingGeneration: probeOwner.pairingGeneration,
      command,
      params: canWhich
        ? { bins: binsList }
        : { command: ["/bin/sh", "-lc", buildBinProbeScript(binsList)] },
      timeoutMs,
    });
    if (!res.ok) {
      recordFailure(res.error?.message ?? "unknown");
      return;
    }
    const bins = parseBinProbePayload(res.payloadJSON, res.payload);
    if (!isCurrentRemoteNodeOwner(params.nodeId, probeOwner)) {
      return;
    }
    const existingBins = remoteNodes.get(params.nodeId)?.bins;
    const nextBins = new Set(bins);
    const hasChanged = !areBinSetsEqual(existingBins, nextBins);
    if (hasChanged) {
      const persisted = await updatePairedNodeBins(
        params.nodeId,
        bins,
        { nodeId: params.nodeId, key: probeOwner.pairingGeneration },
        undefined,
        () => isCurrentRemoteNodeOwner(params.nodeId, probeOwner),
      );
      if (!persisted) {
        return;
      }
    }
    if (!isCurrentRemoteNodeOwner(params.nodeId, probeOwner)) {
      return;
    }
    remoteNodeProbeStates.set(params.nodeId, {
      signature: probeSignature,
      pairingGeneration: probeOwner.pairingGeneration,
      nextProbeAfterMs: Date.now() + REMOTE_BIN_PROBE_SUCCESS_TTL_MS,
      failedProbeCount: 0,
      bins: nextBins,
    });
    recordRemoteNodeBins(params.nodeId, bins, probeOwner.pairingGeneration);
    if (hasChanged) {
      bumpSkillsSnapshotVersion({ reason: "remote-node" });
    }
  } catch (err) {
    recordFailure(err);
  }
}

export function getRemoteSkillEligibility(options?: {
  advertiseExecNode?: boolean;
}): SkillEligibilityContext["remote"] | undefined {
  const currentConnections = listCurrentRemoteConnectionKeys();
  const macNodes = [...remoteNodes.values()].filter(
    (node) =>
      isRemoteSkillEligibilityNode(node) &&
      (!currentConnections ||
        (node.connId !== undefined &&
          currentConnections.has(remoteConnectionKey(node.nodeId, node.connId)))),
  );
  if (macNodes.length === 0) {
    return undefined;
  }
  const bins = new Set<string>();
  for (const node of macNodes) {
    for (const bin of node.bins) {
      bins.add(bin);
    }
  }
  const labels = macNodes.map((node) => node.displayName ?? node.nodeId).filter(Boolean);
  const note =
    options?.advertiseExecNode === false
      ? undefined
      : labels.length > 0
        ? `Remote macOS node available (${labels.join(", ")}). Run macOS-only skills via exec host=node on that node.`
        : "Remote macOS node available. Run macOS-only skills via exec host=node on that node.";
  return {
    platforms: ["darwin"],
    hasBin: (bin) => bins.has(bin),
    hasAnyBin: (required) => required.some((bin) => bins.has(bin)),
    ...(note ? { note } : {}),
  };
}

export async function refreshRemoteBinsForConnectedNodes(cfg: OpenClawConfig) {
  if (!remoteRegistry) {
    return;
  }
  const connected = await remoteRegistry.listCurrentConnected();
  for (const node of connected) {
    try {
      await refreshRemoteNodeBins({
        nodeId: node.nodeId,
        platform: node.platform,
        deviceFamily: node.deviceFamily,
        commands: node.commands,
        cfg,
      });
    } catch (err) {
      // A failed node must not abort refreshes for the remaining connected nodes.
      log.warn(`failed to refresh remote bins for ${describeNode(node.nodeId)}: ${String(err)}`);
    }
  }
}
