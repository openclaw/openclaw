import { writeSync } from "node:fs";
import type { BackupProgressInfo } from "node:sqlite";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { formatErrorMessageWithCode } from "./errors.js";

export const UPDATE_STATE_INSPECTION_PROGRESS_PREFIX = "State schema progress: ";
const DIAGNOSTIC_TAIL_CHARS = 12_000;

const ProgressSchema = z.object({
  phase: z.string(),
  path: z.string().optional(),
  snapshot: z
    .object({
      status: z.enum(["copying", "completed"]),
      copiedPages: z.number().nonnegative(),
      totalPages: z.number().nonnegative(),
      copiedBytes: z.number().nonnegative().optional(),
      elapsedMs: z.number().nonnegative(),
    })
    .optional(),
});
export type UpdateStateInspectionProgress = z.infer<typeof ProgressSchema>;

export function createUpdateStateSnapshotReporter(
  path: string,
  phase: string,
  onProgress?: (progress: UpdateStateInspectionProgress) => void,
) {
  const started = performance.now();
  let emittedAt = -Infinity;
  let pages = { totalPages: 0, remainingPages: 0 };
  const emit = (status: "copying" | "completed", copiedBytes?: number) => {
    const now = performance.now();
    if (status === "copying" && now - emittedAt < 1000 && pages.remainingPages > 0) {
      return;
    }
    emittedAt = now;
    onProgress?.({
      phase,
      path,
      snapshot: {
        status,
        copiedPages: pages.totalPages - pages.remainingPages,
        totalPages: pages.totalPages,
        copiedBytes,
        elapsedMs: Math.max(0, now - started),
      },
    });
  };
  emit("copying");
  return {
    onProgress: (progress: BackupProgressInfo) => {
      pages = progress;
      emit("copying");
    },
    complete: (copiedBytes: number) => emit("completed", copiedBytes),
  };
}

/** Stderr leaves the released worker's stdout JSON contract unchanged. */
export function createUpdateStateInspectionReporter(legacy = false) {
  let emittedBytes = 0;
  let exhausted = false;
  return (progress: UpdateStateInspectionProgress) => {
    if (exhausted) {
      return;
    }
    let line = `${UPDATE_STATE_INSPECTION_PROGRESS_PREFIX}${JSON.stringify(progress)}\n`;
    if (legacy && emittedBytes + Buffer.byteLength(line) > 12_000) {
      // Released parents cap stderr at 20 KB. Stop naming an active source once
      // progress is suppressed, and leave room for the worker's final error.
      exhausted = true;
      line = `${UPDATE_STATE_INSPECTION_PROGRESS_PREFIX}${JSON.stringify({ phase: "schema inspection; detailed progress omitted" })}\n`;
    }
    emittedBytes += Buffer.byteLength(line);
    writeSync(2, line);
  };
}

/** Keep the last source independently of diagnostic output volume and child lifetime. */
export function createUpdateStateInspectionDiagnostics(params: {
  operation: "State schema inspection" | "State schema inventory" | "State snapshot";
  phase: string;
  paths: readonly string[];
  onProgress?: (progress: UpdateStateInspectionProgress) => void;
  stderrLimit?: { bytes: number; onExceeded: () => void };
}) {
  const startedAt = Date.now();
  const decoder = new StringDecoder("utf8");
  let progress: UpdateStateInspectionProgress = {
    phase: params.phase,
    ...(params.paths.length === 1 ? { path: params.paths[0] } : {}),
  };
  let pending = "";
  let tail = "";
  let diagnosticBytes = 0;
  const checkLimit = (pendingBytes = 0) => {
    if (params.stderrLimit && diagnosticBytes + pendingBytes > params.stderrLimit.bytes) {
      params.stderrLimit.onExceeded();
    }
  };
  const receiveLine = (line: string) => {
    if (line.startsWith(UPDATE_STATE_INSPECTION_PROGRESS_PREFIX)) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(line.slice(UPDATE_STATE_INSPECTION_PROGRESS_PREFIX.length));
      } catch {
        // Malformed diagnostics remain ordinary stderr; stdout owns the result.
      }
      const value = ProgressSchema.safeParse(decoded);
      if (value.success) {
        progress = value.data;
        params.onProgress?.(progress);
        return;
      }
    }
    diagnosticBytes += Buffer.byteLength(line) + 1;
    checkLimit();
    tail = `${tail}${line}\n`.slice(-DIAGNOSTIC_TAIL_CHARS);
  };
  return {
    onOutputChunk: (chunk: Buffer, stream: "stdout" | "stderr") => {
      if (stream !== "stderr") {
        return;
      }
      const lines = `${pending}${decoder.write(chunk)}`.split("\n");
      const last = lines.pop() ?? "";
      checkLimit(Buffer.byteLength(last));
      pending = last.slice(-DIAGNOSTIC_TAIL_CHARS);
      diagnosticBytes += Buffer.byteLength(last) - Buffer.byteLength(pending);
      for (const line of lines) {
        receiveLine(line);
      }
    },
    stderr: () => `${tail}${pending}`.trim(),
    failure(reason: unknown, termination?: string) {
      const detail =
        formatErrorMessageWithCode(reason ?? "").trim() ||
        "Worker exited without diagnostic output";
      const elapsed = Math.max(0, Date.now() - startedAt) / 1000;
      const scope = params.paths.slice(0, 3).join(", ");
      const source =
        progress.path ?? `database scope [${scope}${params.paths.length > 3 ? ", …" : ""}]`;
      return new Error(
        `${params.operation} failed${termination ? ` (${termination})` : ""} after ${elapsed.toFixed(3)} seconds during ${progress.phase} for ${source} (scope: ${params.paths.length} database paths): ${detail}. Check database access, free space, and storage performance, then retry the update.`,
        reason instanceof Error ? { cause: reason } : undefined,
      );
    },
  };
}
