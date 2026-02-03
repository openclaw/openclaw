import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

const WIZARD_STATE_FILENAME = "wizard-state.json";

/**
 * Steps in the onboarding wizard flow.
 * Each step represents a checkpoint that can be resumed.
 */
export type WizardStep =
  | "risk-ack"
  | "flow-select"
  | "config-handling"
  | "workspace"
  | "auth-choice"
  | "model-select"
  | "gateway-config"
  | "channels"
  | "skills"
  | "hooks"
  | "completion"
  | "done";

/**
 * Persisted wizard state for resumption after interruption.
 */
export interface WizardState {
  /** Version for state schema migrations */
  version: 1;
  /** Timestamp when wizard was started */
  startedAt: string;
  /** Last completed step */
  lastCompletedStep: WizardStep | null;
  /** Whether wizard completed successfully */
  completed: boolean;
  /** Collected answers to resume from */
  answers: {
    riskAccepted?: boolean;
    flow?: "quickstart" | "advanced";
    configAction?: "keep" | "modify" | "reset";
    workspace?: string;
    authChoice?: string;
    model?: string;
  };
}

function createEmptyState(): WizardState {
  return {
    version: 1,
    startedAt: new Date().toISOString(),
    lastCompletedStep: null,
    completed: false,
    answers: {},
  };
}

function resolveWizardStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env);
  return path.join(stateDir, WIZARD_STATE_FILENAME);
}

/**
 * Load wizard state from disk.
 * Returns null if no state exists or state is invalid.
 */
export async function loadWizardState(
  env: NodeJS.ProcessEnv = process.env,
): Promise<WizardState | null> {
  const statePath = resolveWizardStatePath(env);
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as WizardState;
    if (parsed.version !== 1) {
      // Unknown version, start fresh
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Save wizard state to disk.
 */
export async function saveWizardState(
  state: WizardState,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const statePath = resolveWizardStatePath(env);
  const stateDir = path.dirname(statePath);
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2));
}

/**
 * Clear wizard state (called on successful completion or explicit reset).
 */
export async function clearWizardState(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const statePath = resolveWizardStatePath(env);
  try {
    await fs.unlink(statePath);
  } catch {
    // Ignore if doesn't exist
  }
}

/**
 * Update wizard state with a completed step and optional answers.
 */
export async function updateWizardStep(
  step: WizardStep,
  answers?: Partial<WizardState["answers"]>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let state = await loadWizardState(env);
  if (!state) {
    state = createEmptyState();
  }
  state.lastCompletedStep = step;
  if (answers) {
    state.answers = { ...state.answers, ...answers };
  }
  if (step === "done") {
    state.completed = true;
  }
  await saveWizardState(state, env);
}

/**
 * Mark wizard as complete and clear state.
 */
export async function completeWizard(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await clearWizardState(env);
}

/**
 * Check if there's an incomplete wizard session.
 */
export async function hasIncompleteWizard(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const state = await loadWizardState(env);
  return state !== null && !state.completed;
}

/**
 * Get the step to resume from (the one after lastCompletedStep).
 */
export function getResumeStep(state: WizardState): WizardStep {
  const stepOrder: WizardStep[] = [
    "risk-ack",
    "flow-select",
    "config-handling",
    "workspace",
    "auth-choice",
    "model-select",
    "gateway-config",
    "channels",
    "skills",
    "hooks",
    "completion",
    "done",
  ];

  if (!state.lastCompletedStep) {
    return "risk-ack";
  }

  const lastIndex = stepOrder.indexOf(state.lastCompletedStep);
  if (lastIndex === -1 || lastIndex >= stepOrder.length - 1) {
    return "risk-ack";
  }

  return stepOrder[lastIndex + 1];
}

/**
 * Check if a step should be skipped based on previous state.
 */
export function shouldSkipStep(step: WizardStep, state: WizardState | null): boolean {
  if (!state) {
    return false;
  }

  const stepOrder: WizardStep[] = [
    "risk-ack",
    "flow-select",
    "config-handling",
    "workspace",
    "auth-choice",
    "model-select",
    "gateway-config",
    "channels",
    "skills",
    "hooks",
    "completion",
    "done",
  ];

  if (!state.lastCompletedStep) {
    return false;
  }

  const stepIndex = stepOrder.indexOf(step);
  const lastIndex = stepOrder.indexOf(state.lastCompletedStep);

  return stepIndex <= lastIndex;
}

export { createEmptyState };
