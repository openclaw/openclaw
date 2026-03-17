import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  completeDiagnosis,
  composeDiagnosisPrompt,
  type DiagnosisTrigger,
} from "./oag-diagnosis.js";
import { loadOagMemory } from "./oag-memory.js";

const log = createSubsystemLogger("oag/diagnosis-dispatch");

const DIAGNOSIS_TIMEOUT_MS = 60_000;

type AgentDispatchFn = (params: {
  prompt: string;
  sessionKey: string;
  agentId: string;
}) => Promise<string>;

let registeredDispatch: AgentDispatchFn | null = null;

/**
 * Register the agent dispatch function. Called once during gateway startup
 * when the agent infrastructure is available.
 */
export function registerDiagnosisDispatch(dispatch: AgentDispatchFn): void {
  registeredDispatch = dispatch;
  log.info("Agent diagnosis dispatch registered");
}

export function isDiagnosisDispatchRegistered(): boolean {
  return registeredDispatch !== null;
}

/**
 * Execute a diagnosis by dispatching to the registered agent.
 * Returns the diagnosis result, or null if dispatch is unavailable.
 */
export async function dispatchDiagnosis(
  trigger: DiagnosisTrigger,
  diagnosisId: string,
): Promise<{ dispatched: boolean; applied: number }> {
  if (!registeredDispatch) {
    log.info("Agent diagnosis dispatch not registered — diagnosis deferred");
    return { dispatched: false, applied: 0 };
  }

  const memory = await loadOagMemory();
  const prompt = composeDiagnosisPrompt(trigger, memory);
  const sessionKey = `oag:diagnosis:${diagnosisId}`;

  try {
    log.info(`Dispatching diagnosis ${diagnosisId} to agent`);
    const responseText = await Promise.race([
      registeredDispatch({
        prompt,
        sessionKey,
        agentId: "oag",
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("OAG diagnosis timed out")), DIAGNOSIS_TIMEOUT_MS),
      ),
    ]);

    const result = await completeDiagnosis(diagnosisId, responseText);
    if (!result) {
      log.warn(`Diagnosis ${diagnosisId}: agent responded but parsing failed`);
      return { dispatched: true, applied: 0 };
    }

    // Apply low-risk config recommendations
    const { applyOagConfigChanges } = await import("./oag-config-writer.js");
    const lowRisk = result.recommendations.filter(
      (r) => r.type === "config_change" && r.risk === "low" && r.configPath,
    );
    if (lowRisk.length > 0) {
      const changes = lowRisk.map((r) => ({ configPath: r.configPath!, value: r.suggestedValue }));
      await applyOagConfigChanges(changes);
      log.info(`Diagnosis ${diagnosisId}: applied ${lowRisk.length} low-risk config changes`);
    }

    return { dispatched: true, applied: lowRisk.length };
  } catch (err) {
    log.error(`Diagnosis dispatch failed: ${String(err)}`);
    return { dispatched: false, applied: 0 };
  }
}
