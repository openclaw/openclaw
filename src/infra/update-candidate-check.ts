import fs from "node:fs/promises";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { isEmbeddedStandaloneModule } from "../../cli-invocation.mjs";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import {
  parseOpenClawSchemaVersions,
  type OpenClawSchemaVersions,
} from "../state/openclaw-schema-versions.js";
import { ignoreMissingPath } from "./errno.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { createUpdateFailureFact } from "./update-failure-facts.js";
import type { UpdateStepResult } from "./update-step-result.js";

export type UpdateCandidateCheckResult = {
  status: "ok" | "error";
  steps: UpdateStepResult[];
  /** Database versions the candidate's recovery writer supports. */
  candidateSchemaVersions?: OpenClawSchemaVersions;
  gatewayRestartCompletion?: boolean;
  doctorConfigWrites?: boolean;
};

/**
 * Import the candidate's complete recovery graph and read its update contract
 * before anything live changes. Doctor and Gateway startup are proven on real
 * state after activation; a failure there rolls back to the previous release
 * and its pre-activation database baseline.
 */
export async function checkUpdateCandidate(params: {
  root: string;
  env?: NodeJS.ProcessEnv;
  stateDir: string;
  nodeRunner?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Refuse candidates without the recovery writer instead of using the installed finalizer. */
  requireRuntime?: boolean;
}): Promise<UpdateCandidateCheckResult> {
  const started = Date.now();
  const env = params.env ?? process.env;
  const step = (fields: Partial<UpdateStepResult>): UpdateStepResult => ({
    name: "candidate-recovery",
    command: "--check",
    cwd: params.root,
    durationMs: Date.now() - started,
    exitCode: 0,
    ...fields,
  });
  const fail = (message: string, fields: Partial<UpdateStepResult> = {}) => ({
    status: "error" as const,
    steps: [
      step({
        exitCode: 1,
        stderrTail: message,
        ...fields,
        failureFacts: [
          createUpdateFailureFact(
            { check: "runtime", code: "candidate-runtime-failed", message },
            env,
          ),
        ],
      }),
    ],
  });
  const worker = resolveRuntimeWorkerUrl({
    ...runtimeProcessEntrypoints.updateMigratedFinalize,
    root: params.root,
  });
  try {
    if (!isEmbeddedStandaloneModule(worker.href)) {
      await fs.lstat(worker);
    }
  } catch (error) {
    ignoreMissingPath(error);
    if (params.requireRuntime) {
      return fail("The candidate lacks the runtime required to finish activation.");
    }
    // Older targets finish through the installed updater's shipped path.
    const message = "This version uses the current updater to finish installation";
    return {
      status: "ok",
      steps: [
        step({
          exitCode: null,
          stdoutTail: message,
          advisory: { kind: "candidate-runtime-unavailable", message },
        }),
      ],
    };
  }
  const nodeRunner = params.nodeRunner ?? process.execPath;
  const result = await runUtf8CommandWithTimeout(
    [nodeRunner, ...resolveRuntimeWorkerArgv(worker, nodeRunner), "--check"],
    {
      cwd: params.root,
      baseEnv: env,
      timeoutMs: params.timeoutMs ?? 120_000,
      signal: params.signal,
      killProcessTree: true,
      requireProcessTreeExtinction: true,
      killGraceMs: 500,
      maxOutputBytes: { stdout: 64 * 1024, stderr: 64 * 1024 },
    },
  );
  params.signal?.throwIfAborted();
  if (result.cleanup === "uncertain") {
    throw Object.assign(new Error("Update check process cleanup could not be confirmed."), {
      cleanup: result.cleanup,
    });
  }
  if (result.termination !== "exit" || result.code !== 0) {
    const stderrTail = redactSupportString(
      result.stderr.trim().split(/\r?\n/u).slice(-40).join("\n"),
      { env, stateDir: params.stateDir },
      { maxLength: 8192 },
    );
    return fail(
      `The update could not load its recovery runtime (${result.termination === "exit" ? `exit ${result.code}` : result.termination}).`,
      {
        exitCode: result.termination === "exit" ? result.code : null,
        termination: result.termination,
        signal: result.signal,
        ...(stderrTail ? { stderrTail } : {}),
      },
    );
  }
  const contract = safeParseJsonRecord(result.stdout);
  const candidateSchemaVersions = parseOpenClawSchemaVersions(contract);
  if (!candidateSchemaVersions) {
    return fail("The update did not report its supported database versions");
  }
  return {
    status: "ok",
    steps: [step({})],
    candidateSchemaVersions,
    gatewayRestartCompletion: contract?.gatewayRestartCompletion === true,
    doctorConfigWrites: contract?.doctorConfigWrites === "pid-start-v1",
  };
}
