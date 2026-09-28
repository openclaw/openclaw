import { exitCliAfterOutput } from "../cli/one-shot-exit.js";
import {
  withInstallationTarget,
  type InstallationTarget,
} from "../infra/installation-target-context.js";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import type { RuntimeEnv } from "../runtime.js";

/** Automatic triage owns maintenance only after the embedded turn has fully settled. */
export async function runAutomaticTriageRepair(params: {
  runtime: RuntimeEnv;
  target: InstallationTarget;
  targetEnv: NodeJS.ProcessEnv;
  installRoot: string;
  prompt: string;
  signal: AbortSignal;
  allowGatewayActivation: boolean;
  isCurrent: () => boolean;
  formatError: (error: unknown) => string;
}): Promise<void> {
  const { runtime, target, targetEnv, prompt, isCurrent } = params;
  const redaction = { env: targetEnv, stateDir: target.stateDir };
  const deadline = Date.now() + 600_000;
  const controller = new AbortController();
  const signal = AbortSignal.any([params.signal, controller.signal]);
  const timer = setTimeout(
    () => controller.abort(new Error("Automatic triage timed out.")),
    600_000,
  );
  try {
    const result = await withInstallationTarget(target, async () => {
      const { prepareUpdateRepairInference, runUpdateRepairTurn } =
        await import("../infra/update-repair-agent.runtime.js");
      if (!isCurrent()) {
        return {
          status: "unavailable" as const,
          reason: "Repair authority is no longer current.",
        };
      }
      const selected = await prepareUpdateRepairInference(
        signal,
        Math.max(1, deadline - Date.now()),
      );
      if (!isCurrent()) {
        return {
          status: "unavailable" as const,
          reason: "Repair authority is no longer current.",
        };
      }
      if (!selected.ok) {
        return { status: "unavailable" as const, reason: selected.reason };
      }
      signal.throwIfAborted();
      return runUpdateRepairTurn({
        target: {
          stateDir: target.stateDir,
          configPath: target.configPath,
          workspaceDir: target.defaultWorkspaceDir,
          installRoot: params.installRoot,
        },
        route: selected.route,
        modelFallbacks: selected.modelFallbacks,
        prompt,
        signal,
        timeoutMs: Math.max(1, deadline - Date.now()),
        maxToolCalls: 40,
        isCurrent,
        maintenanceHandoff: true,
      });
    });
    // Inference is bounded; settled maintenance keeps its own phase budgets and
    // remains cancellable by the original owner, not by the expired agent timer.
    clearTimeout(timer);
    if (result.status === "unavailable") {
      runtime.error(params.formatError(result.reason));
      exitCliAfterOutput(runtime, controller.signal.aborted ? 2 : 1);
    }
    if (result.envelope.final) {
      runtime.log(redactSupportString(result.envelope.final, redaction, { maxLength: 32 * 1024 }));
    }
    if (result.envelope.error?.message) {
      runtime.error(params.formatError(result.envelope.error.message));
    }
    if (controller.signal.aborted || result.envelope.status !== "ok") {
      exitCliAfterOutput(
        runtime,
        controller.signal.aborted || result.envelope.status === "timeout" ? 2 : 1,
      );
    }
    if (result.maintenance) {
      const { runUpdateRepairMaintenance } = await import("../infra/update-repair-maintenance.js");
      const maintenance = await runUpdateRepairMaintenance({
        request: result.maintenance,
        target: {
          stateDir: target.stateDir,
          configPath: target.configPath,
          workspaceDir: target.defaultWorkspaceDir,
          installRoot: params.installRoot,
        },
        env: targetEnv,
        allowGatewayActivation: params.allowGatewayActivation,
        signal: params.signal,
        assertCurrent: () => {
          if (!isCurrent()) {
            throw new Error("Repair authority is no longer current.");
          }
        },
      });
      for (const output of [maintenance.stdout, maintenance.stderr]) {
        if (output.trim()) {
          runtime.log(redactSupportString(output, redaction, { maxLength: 32 * 1024 }));
        }
      }
      params.signal.throwIfAborted();
      if (!isCurrent() || maintenance.termination !== "exit" || maintenance.code !== 0) {
        runtime.error(
          "Updater-owned maintenance did not complete; use the manual recovery command above.",
        );
        exitCliAfterOutput(runtime, 1);
      }
      runtime.log(
        "Maintenance completed. Verify the original symptom and intended Gateway state before claiming recovery.",
      );
    }
  } finally {
    clearTimeout(timer);
  }
}
