import type { DatabaseSync } from "node:sqlite";
import { getStateDb } from "./connection.js";

// ── DB provider (overridable for tests) ─────────────────────────────────────

let _dbOverride: DatabaseSync | null = null;

export function setOnboardingDbForTest(db: DatabaseSync): void {
  _dbOverride = db;
}

export function resetOnboardingDbForTest(): void {
  _dbOverride = null;
}

function resolveDb(): DatabaseSync {
  return _dbOverride ?? getStateDb();
}

// ── Types ────────────────────────────────────────────────────────────────────

export type OnboardingStatus = "pending" | "in_progress" | "completed" | "skipped";

export type OnboardingState = {
  status: OnboardingStatus;
  currentStep: number;
  stepsCompleted: number[];
  stepsSkipped: number[];
  configSnapshot: Record<string, unknown>;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number | null;
};

type OnboardingRow = {
  id: number;
  status: string;
  current_step: number;
  steps_completed_json: string | null;
  steps_skipped_json: string | null;
  config_snapshot_json: string | null;
  started_at: number | null;
  completed_at: number | null;
  updated_at: number | null;
};

function rowToState(r: OnboardingRow): OnboardingState {
  return {
    status: r.status as OnboardingStatus,
    currentStep: r.current_step,
    stepsCompleted: r.steps_completed_json ? JSON.parse(r.steps_completed_json) : [],
    stepsSkipped: r.steps_skipped_json ? JSON.parse(r.steps_skipped_json) : [],
    configSnapshot: r.config_snapshot_json ? JSON.parse(r.config_snapshot_json) : {},
    startedAt: r.started_at,
    completedAt: r.completed_at,
    updatedAt: r.updated_at,
  };
}

// ── Read ─────────────────────────────────────────────────────────────────────

export function getOnboardingState(): OnboardingState {
  const db = resolveDb();
  const row = db.prepare("SELECT * FROM op1_onboarding WHERE id = 1").get() as
    | OnboardingRow
    | undefined;
  if (!row) {
    return {
      status: "pending",
      currentStep: 1,
      stepsCompleted: [],
      stepsSkipped: [],
      configSnapshot: {},
      startedAt: null,
      completedAt: null,
      updatedAt: null,
    };
  }
  return rowToState(row);
}

// ── Write ────────────────────────────────────────────────────────────────────

export function upsertOnboardingState(update: {
  status?: OnboardingStatus;
  currentStep?: number;
  stepsCompleted?: number[];
  stepsSkipped?: number[];
  configSnapshot?: Record<string, unknown>;
}): OnboardingState {
  const db = resolveDb();
  const current = getOnboardingState();

  const status = update.status ?? current.status;
  const currentStep = update.currentStep ?? current.currentStep;
  const stepsCompleted = update.stepsCompleted ?? current.stepsCompleted;
  const stepsSkipped = update.stepsSkipped ?? current.stepsSkipped;
  const configSnapshot = update.configSnapshot
    ? { ...current.configSnapshot, ...update.configSnapshot }
    : current.configSnapshot;
  const startedAt =
    status === "in_progress" && current.status === "pending"
      ? Math.floor(Date.now() / 1000)
      : current.startedAt;

  db.prepare(
    `
    INSERT INTO op1_onboarding (id, status, current_step, steps_completed_json, steps_skipped_json, config_snapshot_json, started_at, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      current_step = excluded.current_step,
      steps_completed_json = excluded.steps_completed_json,
      steps_skipped_json = excluded.steps_skipped_json,
      config_snapshot_json = excluded.config_snapshot_json,
      started_at = COALESCE(excluded.started_at, op1_onboarding.started_at),
      updated_at = unixepoch()
  `,
  ).run(
    status,
    currentStep,
    JSON.stringify(stepsCompleted),
    JSON.stringify(stepsSkipped),
    JSON.stringify(configSnapshot),
    startedAt,
  );

  return getOnboardingState();
}

export function markOnboardingComplete(): OnboardingState {
  const db = resolveDb();
  db.prepare(
    `
    UPDATE op1_onboarding SET
      status = 'completed',
      completed_at = unixepoch(),
      updated_at = unixepoch()
    WHERE id = 1
  `,
  ).run();
  return getOnboardingState();
}

export function markOnboardingSkipped(): OnboardingState {
  const db = resolveDb();
  db.prepare(
    `
    UPDATE op1_onboarding SET
      status = 'skipped',
      completed_at = unixepoch(),
      updated_at = unixepoch()
    WHERE id = 1
  `,
  ).run();
  return getOnboardingState();
}

export function resetOnboardingState(): OnboardingState {
  const db = resolveDb();
  db.prepare(
    `
    UPDATE op1_onboarding SET
      status = 'pending',
      current_step = 1,
      steps_completed_json = '[]',
      steps_skipped_json = '[]',
      config_snapshot_json = '{}',
      started_at = NULL,
      completed_at = NULL,
      updated_at = unixepoch()
    WHERE id = 1
  `,
  ).run();
  return getOnboardingState();
}

/** Strip sensitive values (API keys, tokens) from config snapshot for client display */
export function stripConfigSecrets(snapshot: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = /key|token|secret|password|credential/i;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(snapshot)) {
    if (sensitiveKeys.test(k) && typeof v === "string") {
      result[k] =
        v.length > 4 ? `${v.slice(0, 2)}${"*".repeat(v.length - 4)}${v.slice(-2)}` : "****";
    } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      result[k] = stripConfigSecrets(v as Record<string, unknown>);
    } else {
      result[k] = v;
    }
  }
  return result;
}
