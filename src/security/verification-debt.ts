/**
 * Verification Debt Tracker
 * 
 * "Every skipped verification is a loan against future trust."
 * 
 * This module tracks verification events that were deferred or skipped,
 * creating an auditable ledger of technical debt in the security posture.
 */

import fs from "node:fs/promises";
import path from "node:path";

export type VerificationDebtCategory =
  | "security_audit"
  | "skill_scan"
  | "api_health"
  | "memory_injection"
  | "cron_rejection"
  | "external_content";

export type VerificationDebtEntry = {
  id: string;
  category: VerificationDebtCategory;
  description: string;
  skippedAt: number;
  reason: string;
  riskScore: number;
  resolved?: boolean;
  resolvedAt?: number;
  resolvedBy?: string;
};

export type VerificationDebtState = {
  version: 1;
  entries: VerificationDebtEntry[];
  lastPruned: number;
};

const DEBT_FILE = "verification-debt.json";

export async function loadVerificationDebt(params: { workspaceDir: string }): Promise<VerificationDebtState> {
  const debtPath = path.join(params.workspaceDir, "state", DEBT_FILE);
  try {
    const raw = await fs.readFile(debtPath, "utf-8");
    return JSON.parse(raw) as VerificationDebtState;
  } catch {
    return { version: 1, entries: [], lastPruned: Date.now() };
  }
}

export async function saveVerificationDebt(params: {
  workspaceDir: string;
  state: VerificationDebtState;
}): Promise<void> {
  const debtPath = path.join(params.workspaceDir, "state", DEBT_FILE);
  const stateDir = path.dirname(debtPath);
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(debtPath, JSON.stringify(params.state, null, 2), "utf-8");
}

export async function addVerificationDebt(params: {
  workspaceDir: string;
  category: VerificationDebtCategory;
  description: string;
  reason: string;
  riskScore: number;
}): Promise<VerificationDebtEntry> {
  const state = await loadVerificationDebt({ workspaceDir: params.workspaceDir });
  
  const entry: VerificationDebtEntry = {
    id: crypto.randomUUID(),
    category: params.category,
    description: params.description,
    skippedAt: Date.now(),
    reason: params.reason,
    riskScore: Math.max(1, Math.min(10, params.riskScore)),
  };
  
  state.entries.push(entry);
  await saveVerificationDebt({ workspaceDir: params.workspaceDir, state });
  
  return entry;
}

export async function resolveVerificationDebt(params: {
  workspaceDir: string;
  entryId: string;
  resolvedBy: string;
}): Promise<boolean> {
  const state = await loadVerificationDebt({ workspaceDir: params.workspaceDir });
  
  const entry = state.entries.find((e) => e.id === params.entryId);
  if (!entry || entry.resolved) {
    return false;
  }
  
  entry.resolved = true;
  entry.resolvedAt = Date.now();
  entry.resolvedBy = params.resolvedBy;
  
  await saveVerificationDebt({ workspaceDir: params.workspaceDir, state });
  return true;
}

export function calculateDebtScore(state: VerificationDebtState): number {
  const now = Date.now();
  const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
  
  return state.entries.reduce((score, entry) => {
    if (entry.resolved) return score;
    let entryScore = entry.riskScore;
    if (now - entry.skippedAt > oneWeekMs) {
      entryScore *= 2;
    }
    return score + entryScore;
  }, 0);
}

export function getDebtSummary(state: VerificationDebtState): {
  total: number;
  unresolved: number;
  byCategory: Record<VerificationDebtCategory, number>;
  highRisk: VerificationDebtEntry[];
} {
  const unresolved = state.entries.filter((e) => !e.resolved);
  const byCategory: Record<VerificationDebtCategory, number> = {
    security_audit: 0,
    skill_scan: 0,
    api_health: 0,
    memory_injection: 0,
    cron_rejection: 0,
    external_content: 0,
  };
  
  for (const entry of unresolved) {
    byCategory[entry.category]++;
  }
  
  const highRisk = unresolved.filter((e) => e.riskScore >= 7).sort((a, b) => b.riskScore - a.riskScore);
  
  return {
    total: state.entries.length,
    unresolved: unresolved.length,
    byCategory,
    highRisk,
  };
}

export async function pruneResolvedDebts(params: { workspaceDir: string; maxAgeDays: number }): Promise<number> {
  const state = await loadVerificationDebt({ workspaceDir: params.workspaceDir });
  const now = Date.now();
  const maxAgeMs = params.maxAgeDays * 24 * 60 * 60 * 1000;
  
  const initialCount = state.entries.length;
  state.entries = state.entries.filter((entry) => {
    if (!entry.resolved) return true;
    if (now - (entry.resolvedAt ?? 0) < maxAgeMs) return true;
    return false;
  });
  
  state.lastPruned = now;
  await saveVerificationDebt({ workspaceDir: params.workspaceDir, state });
  
  return initialCount - state.entries.length;
}
