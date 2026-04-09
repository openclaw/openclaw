import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAllAgentSessionStoreTargetsSync,
  type SessionEntry,
  updateSessionStore,
} from "../config/sessions.js";
import { discoverAllSessions } from "../infra/session-cost-usage.js";
import {
  listAgentsForGateway,
  loadCombinedSessionStoreForGateway,
  resolveGatewaySessionStoreTarget,
} from "./session-utils.js";

function buildStoreBySessionId(store: Record<string, SessionEntry>): Map<string, [string, SessionEntry]> {
  const storeBySessionId = new Map<string, [string, SessionEntry]>();
  for (const [key, entry] of Object.entries(store)) {
    if (!entry?.sessionId) {
      continue;
    }
    const existing = storeBySessionId.get(entry.sessionId);
    if (!existing || (entry.updatedAt ?? 0) >= (existing[1].updatedAt ?? 0)) {
      storeBySessionId.set(entry.sessionId, [key, entry]);
    }
  }
  return storeBySessionId;
}

function listGatewaySessionStorePaths(cfg: OpenClawConfig): string[] {
  return [...new Set(resolveAllAgentSessionStoreTargetsSync(cfg).map((target) => target.storePath))];
}

function sanitizeRecoveredSessionLabel(text: string | undefined): string | undefined {
  if (typeof text !== "string") {
    return undefined;
  }
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed ? trimmed.slice(0, 120) : undefined;
}

export async function restoreBrokenGatewaySessionStores(cfg: OpenClawConfig): Promise<void> {
  for (const storePath of listGatewaySessionStorePaths(cfg)) {
    try {
      loadSessionStore(storePath, { skipCache: true });
      continue;
    } catch {
      // fall through to repair
    }

    const previousPath = `${storePath}.prev`;
    let restored = false;
    try {
      const raw = fs.readFileSync(previousPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
        await fs.promises.copyFile(previousPath, storePath);
        restored = true;
      }
    } catch {
      // ignore invalid backup and fall through to empty-store bootstrap
    }
    if (restored) {
      continue;
    }

    await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
    if (fs.existsSync(storePath)) {
      const corruptPath = `${storePath}.corrupt.${Date.now()}`;
      await fs.promises.rename(storePath, corruptPath).catch(() => undefined);
    }
    await fs.promises.writeFile(storePath, "{}\n", { mode: 0o600 });
  }
}

export async function recoverGatewaySessionsFromTranscripts(
  cfg: OpenClawConfig,
  opts: {
    ensureStores?: boolean;
    startMs?: number;
    endMs?: number;
  } = {},
): Promise<ReturnType<typeof loadCombinedSessionStoreForGateway>> {
  if (opts.ensureStores !== false) {
    await restoreBrokenGatewaySessionStores(cfg);
  }

  let combined: ReturnType<typeof loadCombinedSessionStoreForGateway>;
  try {
    combined = loadCombinedSessionStoreForGateway(cfg);
  } catch {
    await restoreBrokenGatewaySessionStores(cfg);
    combined = loadCombinedSessionStoreForGateway(cfg);
  }

  const discoveredSessions = (
    await Promise.all(
      listAgentsForGateway(cfg).agents.map(async (agent) =>
        (await discoverAllSessions({
          agentId: agent.id,
          startMs: opts.startMs,
          endMs: opts.endMs,
        })).map((session) => ({ ...session, agentId: agent.id })),
      ),
    )
  )
    .flat()
    .sort((a, b) => b.mtime - a.mtime);

  if (discoveredSessions.length === 0) {
    return combined;
  }

  const storeBySessionId = buildStoreBySessionId(combined.store);
  const pendingByStorePath = new Map<string, Map<string, SessionEntry>>();
  let recoveredCount = 0;

  for (const discovered of discoveredSessions) {
    if (storeBySessionId.has(discovered.sessionId)) {
      continue;
    }
    const target = resolveGatewaySessionStoreTarget({
      cfg,
      key: `agent:${discovered.agentId}:${discovered.sessionId}`,
      scanLegacyKeys: false,
    });
    const pending = pendingByStorePath.get(target.storePath) ?? new Map<string, SessionEntry>();
    if (pending.has(target.canonicalKey)) {
      continue;
    }
    pending.set(target.canonicalKey, {
      sessionId: discovered.sessionId,
      sessionFile: discovered.sessionFile,
      updatedAt: discovered.mtime,
      startedAt: discovered.mtime,
      label: sanitizeRecoveredSessionLabel(discovered.firstUserMessage),
    });
    pendingByStorePath.set(target.storePath, pending);
    recoveredCount += 1;
  }

  for (const [storePath, pending] of pendingByStorePath) {
    await updateSessionStore(storePath, (store) => {
      for (const [key, entry] of pending) {
        if (!store[key]) {
          store[key] = entry;
        }
      }
      return null;
    });
  }

  return recoveredCount > 0 ? loadCombinedSessionStoreForGateway(cfg) : combined;
}

export async function loadResilientCombinedSessionStoreForGateway(
  cfg: OpenClawConfig,
  opts: {
    minStoreEntries?: number;
    forceRecovery?: boolean;
    startMs?: number;
    endMs?: number;
  } = {},
): Promise<ReturnType<typeof loadCombinedSessionStoreForGateway>> {
  try {
    const combined = loadCombinedSessionStoreForGateway(cfg);
    if (opts.forceRecovery === true) {
      return await recoverGatewaySessionsFromTranscripts(cfg, opts);
    }
    if (Object.keys(combined.store).length <= (opts.minStoreEntries ?? 1)) {
      return await recoverGatewaySessionsFromTranscripts(cfg, opts);
    }
    return combined;
  } catch {
    return await recoverGatewaySessionsFromTranscripts(cfg, {
      ...opts,
      ensureStores: true,
    });
  }
}
