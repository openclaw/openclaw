import { readAcpSessionEntry, type AcpSessionStoreEntry } from "../../acp/runtime/session-meta.js";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { parseDiscordTarget } from "../targets.js";
import { resolveChannelIdForBinding } from "./thread-bindings.discord-api.js";
import { getThreadBindingManager } from "./thread-bindings.manager.js";
import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "./thread-bindings.messages.js";
import {
  BINDINGS_BY_THREAD_ID,
  MANAGERS_BY_ACCOUNT_ID,
  ensureBindingsLoaded,
  getThreadBindingToken,
  normalizeThreadId,
  rememberRecentUnboundWebhookEcho,
  removeBindingRecord,
  resolveBindingIdsForSession,
  saveBindingsToDisk,
  setBindingRecord,
  shouldPersistBindingMutations,
} from "./thread-bindings.state.js";
import type { ThreadBindingRecord, ThreadBindingTargetKind } from "./thread-bindings.types.js";

export type AcpThreadBindingReconciliationResult = {
  checked: number;
  removed: number;
  staleSessionKeys: string[];
};

export type AcpThreadBindingHealthStatus = "healthy" | "stale" | "uncertain";

export type AcpThreadBindingHealthProbe = (params: {
  cfg: OpenClawConfig;
  accountId: string;
  sessionKey: string;
  binding: ThreadBindingRecord;
  session: AcpSessionStoreEntry;
}) => Promise<{
  status: AcpThreadBindingHealthStatus;
  reason?: string;
}>;

function normalizeNonNegativeMs(raw: number): number {
  if (!Number.isFinite(raw)) {
    return 0;
  }
  return Math.max(0, Math.floor(raw));
}

function resolveBindingIdsForTargetSession(params: {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: ThreadBindingTargetKind;
}) {
  ensureBindingsLoaded();
  const targetSessionKey = params.targetSessionKey.trim();
  if (!targetSessionKey) {
    return [];
  }
  const accountId = params.accountId ? normalizeAccountId(params.accountId) : undefined;
  return resolveBindingIdsForSession({
    targetSessionKey,
    accountId,
    targetKind: params.targetKind,
  });
}

export function listThreadBindingsForAccount(accountId?: string): ThreadBindingRecord[] {
  const manager = getThreadBindingManager(accountId);
  if (!manager) {
    return [];
  }
  return manager.listBindings();
}

export function listThreadBindingsBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: ThreadBindingTargetKind;
}): ThreadBindingRecord[] {
  const ids = resolveBindingIdsForTargetSession(params);
  return ids
    .map((bindingKey) => BINDINGS_BY_THREAD_ID.get(bindingKey))
    .filter((entry): entry is ThreadBindingRecord => Boolean(entry));
}

export async function autoBindSpawnedDiscordSubagent(params: {
  accountId?: string;
  channel?: string;
  to?: string;
  threadId?: string | number;
  childSessionKey: string;
  agentId: string;
  label?: string;
  boundBy?: string;
}): Promise<ThreadBindingRecord | null> {
  const channel = params.channel?.trim().toLowerCase();
  if (channel !== "discord") {
    return null;
  }
  const manager = getThreadBindingManager(params.accountId);
  if (!manager) {
    return null;
  }
  const managerToken = getThreadBindingToken(manager.accountId);

  const requesterThreadId = normalizeThreadId(params.threadId);
  let channelId = "";
  if (requesterThreadId) {
    const existing = manager.getByThreadId(requesterThreadId);
    if (existing?.channelId?.trim()) {
      channelId = existing.channelId.trim();
    } else {
      channelId =
        (await resolveChannelIdForBinding({
          accountId: manager.accountId,
          token: managerToken,
          threadId: requesterThreadId,
        })) ?? "";
    }
  }
  if (!channelId) {
    const to = params.to?.trim() || "";
    if (!to) {
      return null;
    }
    try {
      const target = parseDiscordTarget(to, { defaultKind: "channel" });
      if (!target || target.kind !== "channel") {
        return null;
      }
      channelId =
        (await resolveChannelIdForBinding({
          accountId: manager.accountId,
          token: managerToken,
          threadId: target.id,
        })) ?? "";
    } catch {
      return null;
    }
  }

  return await manager.bindTarget({
    threadId: undefined,
    channelId,
    createThread: true,
    threadName: resolveThreadBindingThreadName({
      agentId: params.agentId,
      label: params.label,
    }),
    targetKind: "subagent",
    targetSessionKey: params.childSessionKey,
    agentId: params.agentId,
    label: params.label,
    boundBy: params.boundBy ?? "system",
    introText: resolveThreadBindingIntroText({
      agentId: params.agentId,
      label: params.label,
      idleTimeoutMs: manager.getIdleTimeoutMs(),
      maxAgeMs: manager.getMaxAgeMs(),
    }),
  });
}

export function unbindThreadBindingsBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: ThreadBindingTargetKind;
  reason?: string;
  sendFarewell?: boolean;
  farewellText?: string;
}): ThreadBindingRecord[] {
  const ids = resolveBindingIdsForTargetSession(params);
  if (ids.length === 0) {
    return [];
  }

  const removed: ThreadBindingRecord[] = [];
  for (const bindingKey of ids) {
    const record = BINDINGS_BY_THREAD_ID.get(bindingKey);
    if (!record) {
      continue;
    }
    const manager = MANAGERS_BY_ACCOUNT_ID.get(record.accountId);
    if (manager) {
      const unbound = manager.unbindThread({
        threadId: record.threadId,
        reason: params.reason,
        sendFarewell: params.sendFarewell,
        farewellText: params.farewellText,
      });
      if (unbound) {
        removed.push(unbound);
      }
      continue;
    }
    const unbound = removeBindingRecord(bindingKey);
    if (unbound) {
      rememberRecentUnboundWebhookEcho(unbound);
      removed.push(unbound);
    }
  }

  if (removed.length > 0 && shouldPersistBindingMutations()) {
    saveBindingsToDisk({ force: true });
  }
  return removed;
}

export function setThreadBindingIdleTimeoutBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  idleTimeoutMs: number;
}): ThreadBindingRecord[] {
  const ids = resolveBindingIdsForTargetSession(params);
  if (ids.length === 0) {
    return [];
  }
  const idleTimeoutMs = normalizeNonNegativeMs(params.idleTimeoutMs);
  const now = Date.now();
  const updated: ThreadBindingRecord[] = [];
  for (const bindingKey of ids) {
    const existing = BINDINGS_BY_THREAD_ID.get(bindingKey);
    if (!existing) {
      continue;
    }
    const nextRecord: ThreadBindingRecord = {
      ...existing,
      idleTimeoutMs,
      lastActivityAt: now,
    };
    setBindingRecord(nextRecord);
    updated.push(nextRecord);
  }
  if (updated.length > 0 && shouldPersistBindingMutations()) {
    saveBindingsToDisk({ force: true });
  }
  return updated;
}

export function setThreadBindingMaxAgeBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  maxAgeMs: number;
}): ThreadBindingRecord[] {
  const ids = resolveBindingIdsForTargetSession(params);
  if (ids.length === 0) {
    return [];
  }
  const maxAgeMs = normalizeNonNegativeMs(params.maxAgeMs);
  const now = Date.now();
  const updated: ThreadBindingRecord[] = [];
  for (const bindingKey of ids) {
    const existing = BINDINGS_BY_THREAD_ID.get(bindingKey);
    if (!existing) {
      continue;
    }
    const nextRecord: ThreadBindingRecord = {
      ...existing,
      maxAgeMs,
      boundAt: now,
      lastActivityAt: now,
    };
    setBindingRecord(nextRecord);
    updated.push(nextRecord);
  }
  if (updated.length > 0 && shouldPersistBindingMutations()) {
    saveBindingsToDisk({ force: true });
  }
  return updated;
}

function resolveStoredAcpBindingHealth(params: {
  session: AcpSessionStoreEntry;
}): AcpThreadBindingHealthStatus {
  if (!params.session.acp) {
    return "stale";
  }
  if (params.session.acp.state === "error") {
    return "stale";
  }
  return "healthy";
}

export async function reconcileAcpThreadBindingsOnStartup(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  sendFarewell?: boolean;
  healthProbe?: AcpThreadBindingHealthProbe;
}): Promise<AcpThreadBindingReconciliationResult> {
  const manager = getThreadBindingManager(params.accountId);
  if (!manager) {
    return {
      checked: 0,
      removed: 0,
      staleSessionKeys: [],
    };
  }

  const acpBindings = manager.listBindings().filter((binding) => binding.targetKind === "acp");
  const staleBindings: ThreadBindingRecord[] = [];

  for (const binding of acpBindings) {
    const sessionKey = binding.targetSessionKey.trim();
    if (!sessionKey) {
      staleBindings.push(binding);
      continue;
    }
    const session = readAcpSessionEntry({
      cfg: params.cfg,
      sessionKey,
    });
    if (!session) {
      staleBindings.push(binding);
      continue;
    }
    // Session store read failures are transient; never auto-unbind on uncertain reads.
    if (session.storeReadFailed) {
      continue;
    }

    if (resolveStoredAcpBindingHealth({ session }) === "stale") {
      staleBindings.push(binding);
      continue;
    }

    if (!params.healthProbe) {
      continue;
    }

    let probeStatus: AcpThreadBindingHealthStatus = "uncertain";
    try {
      const result = await params.healthProbe({
        cfg: params.cfg,
        accountId: manager.accountId,
        sessionKey,
        binding,
        session,
      });
      probeStatus = result.status;
    } catch {
      // Treat probe failures as uncertain and keep the binding.
      probeStatus = "uncertain";
    }

    if (probeStatus === "stale") {
      staleBindings.push(binding);
    }
  }

  if (staleBindings.length === 0) {
    return {
      checked: acpBindings.length,
      removed: 0,
      staleSessionKeys: [],
    };
  }

  const staleSessionKeys: string[] = [];
  let removed = 0;
  for (const binding of staleBindings) {
    staleSessionKeys.push(binding.targetSessionKey);
    const unbound = manager.unbindThread({
      threadId: binding.threadId,
      reason: "stale-session",
      sendFarewell: params.sendFarewell ?? false,
    });
    if (unbound) {
      removed += 1;
    }
  }

  return {
    checked: acpBindings.length,
    removed,
    staleSessionKeys: [...new Set(staleSessionKeys)],
  };
}
