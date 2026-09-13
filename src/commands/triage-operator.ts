import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { exitCliAfterOutput } from "../cli/one-shot-exit.js";
import { createEmbeddedStateSignalBridge } from "../infra/embedded-state-lock.js";
import {
  installationTargetEnv,
  type InstallationTarget,
} from "../infra/installation-target-context.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import {
  continueTriageInFreshProcess,
  resolveTriageEntrypoint,
} from "../infra/triage-continuation.js";
import { updateRepairWorkerMessageSchema } from "../infra/update-repair-protocol.js";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import {
  readTriageUpdateFailure,
  sanitizeTriageUpdateFailure,
  writeTriageUpdateFailure,
  type TriageUpdateFailure,
} from "./triage-update.js";

/** An operator request carries intent, not a fabricated update failure or execution authority. */
export async function runOperatorTriage(params: {
  runtime: RuntimeEnv;
  target: InstallationTarget;
  json: boolean;
  noExport: boolean;
  updateResult?: string;
  updateFailure?: TriageUpdateFailure;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}) {
  const bridge = createEmbeddedStateSignalBridge();
  const signal = params.signal ? AbortSignal.any([params.signal, bridge.signal]) : bridge.signal;
  const target = { ...params.target };
  const targetEnv = { ...process.env, ...installationTargetEnv(target) };
  const redaction = { env: targetEnv, stateDir: target.stateDir };
  const inputPath = params.updateResult ? path.resolve(params.updateResult) : undefined;
  let diagnostics = "";
  let report: unknown;
  let updateRunId: string | undefined;
  let code = 1;
  let failedTransport = false;
  let summary = "Repair did not complete. Inspect the saved diagnostics before retrying.";
  try {
    signal.throwIfAborted();
    if (params.isCurrent?.() === false) {
      throw new Error("The original operator request is no longer current.");
    }
    const failure = params.updateFailure
      ? sanitizeTriageUpdateFailure(params.updateFailure, redaction)
      : inputPath
        ? await readTriageUpdateFailure(inputPath, redaction)
        : undefined;
    updateRunId = failure && "result" in failure ? failure.result.runId : undefined;
    signal.throwIfAborted();
    const savedFailure = failure
      ? await writeTriageUpdateFailure(failure, { env: targetEnv }).catch(() => undefined)
      : undefined;
    const selected = await resolveOpenClawPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
    });
    if (!selected) {
      throw new Error("The selected installed CLI is unavailable.");
    }
    const root = await fs.realpath(selected);
    const commandArgv = [
      ...(await resolveTriageEntrypoint(root)),
      "--run",
      "--json",
      "--non-interactive",
      ...(params.noExport ? ["--no-export"] : []),
      ...(savedFailure ? ["--update-result", savedFailure] : []),
    ];
    signal.throwIfAborted();
    if (params.isCurrent?.() === false) {
      throw new Error("The original operator request is no longer current.");
    }
    const outcome = await continueTriageInFreshProcess({
      root,
      commandArgv,
      target,
      operator: {
        kind: "operator",
        installationRoot: root,
        gateway: "preserve",
        ...(failure ? { updateFailure: failure } : {}),
      },
      signal,
      output: (text) => {
        diagnostics = (diagnostics + text).slice(-32 * 1024);
      },
    });
    if (outcome.status === "not-running") {
      report = { updateRunId, repair: outcome };
      summary =
        "Repair is already owned for this installation. Wait for its cleanup before retrying.";
    } else {
      if (outcome.commandOutput.kind !== "complete") {
        throw new Error("Repair output exceeded its bound; verification is unavailable.");
      }
      const parsed = z
        .object({
          installationRoot: z.literal(root),
          updateRunId: updateRunId ? z.literal(updateRunId) : z.undefined().optional(),
          repair: z.unknown(),
          repairTaskId: z.uuid().optional().catch(undefined),
        })
        .parse(JSON.parse(outcome.commandOutput.stdout));
      const result = updateRepairWorkerMessageSchema.parse({
        type: "result",
        result: parsed.repair,
      });
      if (result.type !== "result") {
        throw new Error("Repair returned no result.");
      }
      if (result.result.status === "repaired" && !result.result.finalValidation.ok) {
        throw new Error("Repair claimed success without passing independent validation.");
      }
      const projection = await import("./triage-task-result.js").catch(() => undefined);
      projection?.settleTriageRepairTask({
        taskId: parsed.repairTaskId,
        outcome,
        root,
        target,
        updateRunId,
        repair: result.result,
        signal,
        isCurrent: params.isCurrent,
      });
      report = { installationRoot: root, updateRunId, repair: result.result };
      const reason = redactSupportString(
        result.result.reason ?? result.result.finalValidation.summary,
        redaction,
        { maxLength: 1024 },
      );
      summary = `Repair incomplete: ${reason}`;
      if (result.result.status === "unavailable") {
        summary +=
          result.result.reason === "exec-denied-by-policy"
            ? " Use `openclaw triage` for an external handoff."
            : " Run `openclaw onboard` or use a suggested handoff command.";
      }
      code =
        result.result.status === "repaired" && result.result.finalValidation.ok
          ? 0
          : result.result.reason === "per-turn-budget" ||
              result.result.reason === "wall-clock-budget"
            ? 2
            : 1;
    }
  } catch (error) {
    failedTransport = true;
    const reason = redactSupportString(
      error instanceof Error ? error.message : String(error),
      redaction,
      { maxLength: 1024 },
    );
    summary = `Repair unavailable: ${reason}`;
    report = {
      updateRunId,
      repair: {
        status: "unavailable",
        reason,
      },
    };
  } finally {
    bridge.dispose();
  }
  if (signal.aborted || params.isCurrent?.() === false) {
    return;
  }
  if (params.json) {
    writeRuntimeJson(params.runtime, report);
  } else {
    params.runtime.log(
      code === 0 ? "Repair checks passed. Gateway activation is reported separately." : summary,
    );
  }
  if (code !== 0) {
    if (failedTransport && diagnostics.trim()) {
      params.runtime.error(redactSupportString(diagnostics, redaction, { maxLength: 32 * 1024 }));
    }
    exitCliAfterOutput(params.runtime, code);
  }
}
