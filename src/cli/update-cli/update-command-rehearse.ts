import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { resolveStateDir } from "../../config/paths.js";
import { withCanaryProcessObserver } from "../../infra/update-candidate-canary-process.js";
import { validateUpdateCandidateCanary } from "../../infra/update-candidate-canary.js";
import {
  formatUpdateRehearsalEventLine,
  parseUpdateRehearsalReceiptAnswer,
  parseUpdateRehearsalRequest,
  UPDATE_REHEARSAL_HEARTBEAT_MS,
  UPDATE_REHEARSAL_PROTOCOL,
  type UpdateRehearsalEvent,
} from "../../infra/update-rehearsal-contract.js";
import { redactSupportDiagnosticLine } from "../../logging/diagnostic-support-redaction.js";
import { resolveCommandProcessSignal, withCommandProcessScope } from "../../process/exec-spawn.js";
import { defaultRuntime } from "../../runtime.js";
import { withArtifactPreservingStateReads } from "../../state/artifact-preserving-state-reads.js";
import { resolveCandidateInspectionContext } from "./update-command-preflight.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";

// The request carries one resolved config source.
const REQUEST_MAX_BYTES = 16 * 1024 * 1024;
// A check that ran out of time or a state copy that failed says nothing about this
// candidate or the profile's data, so neither can refuse an update.
const INCONCLUSIVE_REASONS: ReadonlySet<string> = new Set([
  "candidate-checks-timeout",
  "candidate-snapshot-failed",
]);

type Receipt = Extract<UpdateRehearsalEvent, { seq: number }>;
// Distributes over the union so each receipt keeps its own step type.
type ReceiptBody = Receipt extends infer Each
  ? Each extends Receipt
    ? Omit<Each, "seq">
    : never
  : never;

/**
 * Each receipt waits for the updater's answer on stdin, so no check starts or completes
 * before the updater has committed it. A refusal or a lost updater ends the rehearsal.
 */
function openReceiptChannel(emit: (event: UpdateRehearsalEvent) => void) {
  let lastSeq = 0;
  let lost: Error | undefined;
  const waiting = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  const answers = createInterface({ input: process.stdin });
  answers.on("line", (line) => {
    const answer = parseUpdateRehearsalReceiptAnswer(line);
    const waiter = answer ? waiting.get(answer.seq) : undefined;
    if (!answer || !waiter) {
      return;
    }
    waiting.delete(answer.seq);
    if (answer.ok) {
      waiter.resolve();
    } else {
      waiter.reject(new Error("The updater refused a rehearsal receipt."));
    }
  });
  answers.once("close", () => {
    lost = new Error("The updater stopped answering rehearsal receipts.");
    for (const waiter of waiting.values()) {
      waiter.reject(lost);
    }
    waiting.clear();
  });
  return {
    send: (receipt: ReceiptBody) =>
      new Promise<void>((resolve, reject) => {
        if (lost) {
          reject(lost);
          return;
        }
        lastSeq += 1;
        waiting.set(lastSeq, { resolve, reject });
        emit({ ...receipt, seq: lastSeq });
      }),
    close: () => answers.close(),
  };
}

/**
 * Candidate-owned rehearsal for an installed updater: this package checks itself against
 * copied state with its own logic and budgets. It never admits or mutates a live update.
 */
export async function updateRehearseCommand(requestPath?: string): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  // Events are receipts for the updater's ledger; stdout stays one result document.
  const emit = (event: UpdateRehearsalEvent) => {
    process.stderr.write(formatUpdateRehearsalEventLine(event));
  };
  const heartbeat = setInterval(() => emit({ type: "heartbeat" }), UPDATE_REHEARSAL_HEARTBEAT_MS);
  heartbeat.unref();
  const receipts = openReceiptChannel(emit);
  try {
    const { root, env } = await resolveCandidateInspectionContext("rehearsal");
    if (!requestPath || !path.isAbsolute(requestPath)) {
      throw new Error("Candidate rehearsal request path is missing or invalid.");
    }
    const stat = await fs.stat(requestPath);
    if (!stat.isFile() || stat.size > REQUEST_MAX_BYTES) {
      throw new Error("Candidate rehearsal request is not a bounded regular file.");
    }
    const request = parseUpdateRehearsalRequest(JSON.parse(await fs.readFile(requestPath, "utf8")));
    if (!request) {
      throw new Error("Candidate rehearsal request is invalid.");
    }
    const result = await withOwnedManagedUpdateEnv(env, () =>
      withCommandProcessScope(
        () =>
          withArtifactPreservingStateReads(() =>
            // Checks run in their own process groups; the updater stops any left behind.
            withCanaryProcessObserver(
              {
                started: (pid) => emit({ type: "process", pid }),
                closed: (pid) => emit({ type: "process-closed", pid }),
              },
              () =>
                validateUpdateCandidateCanary({
                  root,
                  ...(request.sourceBundledPlugins
                    ? { sourceBundledPlugins: request.sourceBundledPlugins }
                    : {}),
                  config: request.config,
                  stateDir: resolveStateDir(env),
                  env,
                  timeoutMs: request.timeoutMs,
                  fullIntegrityCheck: request.fullIntegrityCheck,
                  gatewayStartupRuntime: request.gatewayStartupRuntime,
                  signal: resolveCommandProcessSignal(),
                  onProgress: (step) => receipts.send({ type: "progress", step }),
                  onStep: (step) => receipts.send({ type: "step", step }),
                }),
            ),
          ),
        controller.signal,
      ),
    );
    controller.signal.throwIfAborted();
    if (result.status === "error" && INCONCLUSIVE_REASONS.has(result.reason)) {
      throw new Error(`Candidate rehearsal was inconclusive (${result.reason}).`);
    }
    // Publish only after snapshot and child cleanup has settled.
    defaultRuntime.writeJson({ protocol: UPDATE_REHEARSAL_PROTOCOL, result });
    process.exitCode = result.status === "ok" ? 0 : 3;
  } catch (error) {
    defaultRuntime.error(
      redactSupportDiagnosticLine(error instanceof Error ? error.message : String(error), {
        env: process.env,
        stateDir: resolveStateDir(process.env),
      }),
    );
    // No result: the installed updater runs its own rehearsal.
    defaultRuntime.writeJson({
      protocol: UPDATE_REHEARSAL_PROTOCOL,
      error: "rehearsal-execution-failed",
    });
    process.exitCode = 2;
  } finally {
    receipts.close();
    clearInterval(heartbeat);
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
