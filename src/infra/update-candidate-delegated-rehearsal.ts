import fs from "node:fs/promises";
import path from "node:path";
import { withTempWorkspace } from "@openclaw/fs-safe/temp";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGatewayInstallEntrypoint } from "../daemon/gateway-entrypoint.js";
import { tryReadJson } from "./json-files.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
import { createUpdateCandidateInspectionEnv } from "./update-candidate-admission.js";
import type {
  CanaryResult,
  UpdateCandidateCanaryParams,
} from "./update-candidate-canary-commands.js";
import { launchCanary, terminateCanary, waitBounded } from "./update-candidate-canary-process.js";
import {
  parseUpdateRehearsalEventLine,
  parseUpdateRehearsalResult,
  UPDATE_REHEARSAL_EVENT_PREFIX,
  UPDATE_REHEARSAL_PROTOCOL,
  type UpdateRehearsalRequest,
} from "./update-rehearsal-contract.js";

/**
 * Liveness, not a work budget: the candidate sends a heartbeat every few seconds, so this
 * much silence means its orchestrating process is gone or blocked. Slow checks never trip it.
 */
const REHEARSAL_STALL_MS = 15 * 60_000;
const REHEARSAL_CLEANUP_MS = 2_000;
/** A cancelled candidate removes its own temporary state copies before it is forced to stop. */
const REHEARSAL_CANCEL_GRACE_MS = 5 * 60_000;

export type DelegatedUpdateCandidateRehearsal =
  | { owner: "candidate"; result: CanaryResult }
  | { owner: "installed"; fallbackReason: string; diagnostic?: string };

/**
 * Ask the staged candidate to rehearse itself. It receives data and no update authority,
 * and touches copied state only. A refusal is binding; a missing or invalid result returns
 * the rehearsal to the installed updater.
 */
export async function runDelegatedUpdateCandidateRehearsal(
  params: Omit<UpdateCandidateCanaryParams, "migrationPolicy">,
): Promise<DelegatedUpdateCandidateRehearsal> {
  const manifest = await tryReadJson<unknown>(path.join(params.root, "package.json"), {
    maxBytes: 1024 * 1024,
  });
  if (
    !isRecord(manifest) ||
    !isRecord(manifest.openclaw) ||
    manifest.openclaw.updateRehearsalProtocol !== UPDATE_REHEARSAL_PROTOCOL
  ) {
    return { owner: "installed", fallbackReason: "unsupported-target" };
  }
  const entry = await resolveGatewayInstallEntrypoint(params.root);
  if (!entry) {
    return { owner: "installed", fallbackReason: "missing-entrypoint" };
  }
  const candidateVersion = typeof manifest.version === "string" ? manifest.version : null;
  return await withTempWorkspace(
    { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-update-rehearsal-" },
    async ({ dir }): Promise<DelegatedUpdateCandidateRehearsal> => {
      const requestPath = path.join(dir, "request.json");
      const request: UpdateRehearsalRequest = {
        protocol: UPDATE_REHEARSAL_PROTOCOL,
        config: params.config,
        ...(params.sourceBundledPlugins
          ? { sourceBundledPlugins: params.sourceBundledPlugins }
          : {}),
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
        ...(params.fullIntegrityCheck === undefined
          ? {}
          : { fullIntegrityCheck: params.fullIntegrityCheck }),
        ...(params.gatewayStartupRuntime
          ? { gatewayStartupRuntime: params.gatewayStartupRuntime }
          : {}),
      };
      // The rehearsal writes this same source to its private state copy with the same mode.
      await fs.writeFile(requestPath, JSON.stringify(request), { mode: 0o600, flag: "wx" });

      let lastActivityAt = Date.now();
      let relay = Promise.resolve();
      let relayFailure: { error: unknown } | undefined;
      const relayAbort = new AbortController();
      const running = launchCanary({
        assertCurrent: params.assertCurrent,
        target: { kind: "cli", entryPath: entry },
        args: ["update", "rehearse", "--request", requestPath],
        root: params.root,
        env: createUpdateCandidateInspectionEnv(
          params.env ?? process.env,
          params.root,
          candidateVersion,
        ),
        nodeRunner: params.nodeRunner,
        stateDir: params.stateDir,
        capture: () => {},
        hidesLine: (line) => line.startsWith(UPDATE_REHEARSAL_EVENT_PREFIX),
        onLine: (line) => {
          lastActivityAt = Date.now();
          const event = parseUpdateRehearsalEventLine(line);
          if (!event || event.type === "heartbeat") {
            return;
          }
          // Receipts keep the candidate's order; a refused receipt ends the rehearsal.
          relay = relay.then(async () => {
            if (relayFailure) {
              return;
            }
            try {
              params.assertCurrent?.();
              await (event.type === "progress"
                ? params.onProgress?.(event.step)
                : params.onStep?.(event.step));
            } catch (error) {
              relayFailure = { error };
              relayAbort.abort();
            }
          });
        },
      });
      const signal = params.signal
        ? AbortSignal.any([params.signal, relayAbort.signal])
        : relayAbort.signal;
      let outcome: Awaited<ReturnType<typeof waitBounded<number | null>>> | undefined;
      try {
        for (;;) {
          outcome = await waitBounded(
            running.result,
            lastActivityAt + REHEARSAL_STALL_MS - Date.now(),
            signal,
          );
          if (outcome.status !== "deadline" || Date.now() - lastActivityAt >= REHEARSAL_STALL_MS) {
            break;
          }
        }
      } finally {
        // Cancellation reaches a live candidate; a silent one is presumed unable to respond.
        if (outcome?.status === "aborted" && running.child.kill("SIGTERM")) {
          await waitBounded(running.closed, REHEARSAL_CANCEL_GRACE_MS);
        }
        await terminateCanary(running.child, running.closed, Date.now() + REHEARSAL_CLEANUP_MS);
      }
      await relay;
      if (relayFailure) {
        throw relayFailure.error;
      }
      params.signal?.throwIfAborted();
      params.assertCurrent?.();

      const fallback = (fallbackReason: string): DelegatedUpdateCandidateRehearsal => {
        const diagnostic = running.stderrDiagnostic();
        return { owner: "installed", fallbackReason, ...(diagnostic ? { diagnostic } : {}) };
      };
      if (outcome?.status !== "completed") {
        return fallback("stalled");
      }
      const code = outcome.value;
      if (code !== 0 && code !== 3) {
        return fallback(code === null ? "crash" : `exit-${code}`);
      }
      if (running.outputExceeded()) {
        return fallback("output-limit");
      }
      let value: unknown;
      try {
        value = JSON.parse(running.stdout());
      } catch {
        return fallback("malformed-json");
      }
      const result = parseUpdateRehearsalResult(value);
      // The exit status and the document must agree before either is believed.
      if (!result || code !== (result.status === "ok" ? 0 : 3)) {
        return fallback("invalid-result");
      }
      return { owner: "candidate", result };
    },
  );
}
