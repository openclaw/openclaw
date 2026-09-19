import { writeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { formatErrorMessageWithCode } from "./errors.js";

export const UPDATE_STATE_INSPECTION_PROGRESS_PREFIX = "State schema progress: ";
const DIAGNOSTIC_TAIL_CHARS = 12_000;

const ProgressSchema = z.object({ phase: z.string(), path: z.string().optional() });
export type UpdateStateInspectionProgress = z.infer<typeof ProgressSchema>;

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
  operation: "State schema inspection" | "State schema inventory";
  phase: string;
  paths: readonly string[];
}) {
  const startedAt = Date.now();
  const decoder = new StringDecoder("utf8");
  let progress: UpdateStateInspectionProgress = {
    phase: params.phase,
    ...(params.paths.length === 1 ? { path: params.paths[0] } : {}),
  };
  let pending = "";
  let tail = "";
  const receiveLine = (line: string) => {
    if (line.startsWith(UPDATE_STATE_INSPECTION_PROGRESS_PREFIX)) {
      try {
        const value = ProgressSchema.safeParse(
          JSON.parse(line.slice(UPDATE_STATE_INSPECTION_PROGRESS_PREFIX.length)),
        );
        if (value.success) {
          progress = value.data;
          return;
        }
      } catch {
        // Malformed diagnostics remain ordinary stderr; stdout owns the result.
      }
    }
    tail = `${tail}${line}\n`.slice(-DIAGNOSTIC_TAIL_CHARS);
  };
  return {
    onOutputChunk: (chunk: Buffer, stream: "stdout" | "stderr") => {
      if (stream !== "stderr") {
        return;
      }
      const lines = `${pending}${decoder.write(chunk)}`.split("\n");
      pending = (lines.pop() ?? "").slice(-DIAGNOSTIC_TAIL_CHARS);
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
        `${params.operation} failed${termination ? ` (${termination})` : ""} after ${elapsed.toFixed(3)} seconds during ${progress.phase} for ${source} (scope: ${params.paths.length} database paths): ${detail}. Check database access, concurrent writers, and storage performance, then retry the update.`,
        reason instanceof Error ? { cause: reason } : undefined,
      );
    },
  };
}
