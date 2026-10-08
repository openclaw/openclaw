import { AsyncLocalStorage } from "node:async_hooks";
import { stripVTControlCharacters } from "node:util";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { resolveStateDir } from "../../config/paths.js";
import { getConsoleSettings } from "../../logging/console.js";
import { redactSupportString } from "../../logging/diagnostic-support-redaction.js";
import { formatConsoleDiagnosticLine } from "../../logging/json-console-line.js";
import { isLogLevelEnabled } from "../../logging/levels.js";
import type { CommandOutputStream } from "../../process/exec-output.js";
import { resolveCommandProcessSignal } from "../../process/exec-spawn.js";
import { truncateUtf8Prefix, truncateUtf8Suffix } from "../../utils/utf8-truncate.js";

const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_EXCERPT_BYTES = 256;
const outputScope = new AsyncLocalStorage<UpdateFinalizationOutput>();

function redactDoctorOutput(text: string): string | undefined {
  const withoutCompleteKeys = text.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
    "",
  );
  if (withoutCompleteKeys.includes("PRIVATE KEY-----")) {
    return undefined;
  }
  return redactSupportString(
    text,
    { env: process.env, stateDir: resolveStateDir() },
    { maxLength: Number.MAX_SAFE_INTEGER },
  );
}

class CapturedStream {
  private buffer?: Buffer;
  private receivedBytes = 0;
  private lastOutputAt?: number;

  append(chunk: Buffer): void {
    if (chunk.length === 0) {
      return;
    }
    const offset = this.receivedBytes;
    this.receivedBytes = Math.min(Number.MAX_SAFE_INTEGER, offset + chunk.length);
    this.lastOutputAt = performance.now();
    if (this.receivedBytes > MAX_CAPTURE_BYTES) {
      // Never redact a raw tail whose credential prefix may have been discarded.
      this.buffer = undefined;
      return;
    }
    this.buffer ??= Buffer.alloc(MAX_CAPTURE_BYTES);
    chunk.copy(this.buffer, offset);
  }

  snapshot() {
    const facts = {
      receivedBytes: this.receivedBytes,
      lastOutputAgeMs:
        this.lastOutputAt === undefined
          ? null
          : Math.max(0, Math.round(performance.now() - this.lastOutputAt)),
    };
    if (this.receivedBytes > MAX_CAPTURE_BYTES) {
      return { ...facts, omitted: "capture-limit" as const };
    }
    const text = this.buffer?.subarray(0, this.receivedBytes).toString("utf8") ?? "";
    // A timeout may interrupt a multiline private key before the existing full-block
    // redactor can match it. Suppress that stream rather than publish its body.
    try {
      const redacted = redactDoctorOutput(text);
      if (redacted === undefined) {
        return { ...facts, omitted: "incomplete-private-key" as const };
      }
      const excerpt =
        Buffer.byteLength(redacted) <= MAX_EXCERPT_BYTES
          ? redacted
          : `${truncateUtf8Prefix(redacted, 160)}\n...\n${truncateUtf8Suffix(redacted, 91)}`;
      return { ...facts, excerpt };
    } catch {
      return { ...facts, omitted: "redaction-failed" as const };
    }
  }
}

/** Diagnostic custody only. This scope never cancels work or authorizes rollback. */
export class UpdateFinalizationOutput {
  private doctor?: {
    phase: "pre-plugin" | "post-plugin";
    stdout: CapturedStream;
    stderr: CapturedStream;
  };
  private closed = false;

  run<T>(run: () => Promise<T>): Promise<T> {
    return outputScope.run(this, run);
  }

  captureDoctor(phase: "pre-plugin" | "post-plugin") {
    const doctor = { phase, stdout: new CapturedStream(), stderr: new CapturedStream() };
    this.doctor = doctor;
    return (chunk: Buffer, stream: CommandOutputStream): void => {
      if (!this.closed && this.doctor === doctor) {
        doctor[stream].append(chunk);
      }
    };
  }

  snapshot() {
    return this.doctor
      ? {
          phase: this.doctor.phase,
          stdout: this.doctor.stdout.snapshot(),
          stderr: this.doctor.stderr.snapshot(),
        }
      : undefined;
  }

  close(): void {
    this.closed = true;
    this.doctor = undefined;
  }
}

/** Frame before interpretation: a clipped line must never become a new diagnostic. */
class DoctorOutputLines {
  private readonly buffer = Buffer.alloc(8 * 1024);
  private used = 0;
  private dropping = false;

  constructor(private readonly onLine: (line: string) => void) {}

  append(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const length = end - offset;
      if (!this.dropping && this.used + length <= this.buffer.length) {
        chunk.copy(this.buffer, this.used, offset, end);
        this.used += length;
      } else {
        this.dropping = true;
      }
      if (newline < 0) {
        return;
      }
      if (!this.dropping) {
        this.onLine(this.buffer.subarray(0, this.used).toString("utf8"));
      }
      this.used = 0;
      this.dropping = false;
      offset = newline + 1;
    }
  }
}

function readDoctorOperationProgress(raw: string, phase?: "pre-plugin" | "post-plugin") {
  const line = stripVTControlCharacters(raw).trim();
  const record = line.startsWith("{") ? safeParseJsonRecord(line) : undefined;
  const message = typeof record?.message === "string" ? record.message : line;
  const prefix = "[update progress] ";
  if (message.startsWith(prefix)) {
    const progress = safeParseJsonRecord(message.slice(prefix.length));
    if (
      progress?.operation === "sqlite-integrity" &&
      (progress.phase === "pre-plugin" || progress.phase === "post-plugin") &&
      typeof progress.operationPhase === "string" &&
      /^(starting|opening|checking|closing|result-received)$/u.test(progress.operationPhase) &&
      typeof progress.elapsedMs === "number" &&
      Number.isSafeInteger(progress.elapsedMs) &&
      progress.elapsedMs >= 0
    ) {
      return {
        phase: progress.phase,
        operation: "sqlite-integrity" as const,
        operationPhase: progress.operationPhase,
        elapsedMs: progress.elapsedMs,
        ...(typeof progress.size === "string" &&
        /^\d{1,12}(?:\.\d{1,3})? (?:B|KiB|MiB|GiB)$/u.test(progress.size)
          ? { size: progress.size }
          : {}),
      };
    }
    return undefined;
  }
  // sqlite-integrity-worker owns these observations, including in shipped children.
  // Project only its closed fields; never forward database labels or arbitrary prose.
  const match =
    /(?:^|\] )SQLite integrity check still running: .+ \((unknown size|\d{1,12}(?:\.\d{1,3})? (?:B|KiB|MiB|GiB)), (\d{1,10})s elapsed, phase=(starting|opening|checking|closing|result-received)\)\.$/u.exec(
      message,
    );
  return match && phase
    ? {
        phase,
        operation: "sqlite-integrity" as const,
        operationPhase: match[3],
        elapsedMs: Number(match[2]) * 1000,
        ...(match[1] === "unknown size" ? {} : { size: match[1] }),
      }
    : undefined;
}

/** Display-only projection of child output, independent of the parent's ledger or service custody. */
export function streamUpdateFinalizationDoctorOutput(phase?: "pre-plugin" | "post-plugin") {
  const capture = phase ? outputScope.getStore()?.captureDoctor(phase) : undefined;
  const signal = resolveCommandProcessSignal();
  const enabled = isLogLevelEnabled("info", getConsoleSettings().level);
  let closed = false;
  let lastProgressAt = -Infinity;
  const write = (prefix: string, facts: object) => {
    const message = `[${prefix}] ${JSON.stringify(facts)}`;
    process.stderr.write(formatConsoleDiagnosticLine({ level: "info", message }) + "\n");
  };
  const lines = (stream: CommandOutputStream) =>
    new DoctorOutputLines((line) => {
      const progress = readDoctorOperationProgress(line, phase);
      if (progress) {
        const now = performance.now();
        if (enabled && now - lastProgressAt >= 1000) {
          lastProgressAt = now;
          write("update progress", {
            stream,
            ...progress,
            cancellation: signal ? (signal.aborted ? "requested" : "available") : "unknown",
          });
        }
      }
    });
  const streams = { stdout: lines("stdout"), stderr: lines("stderr") };
  const remainingOutput = (text: string): string =>
    text
      .split(/\r?\n/u)
      .filter((line) => !readDoctorOperationProgress(line, phase))
      .join("\n");
  return {
    /** The outer worker's other diagnostics keep their existing completion-only path. */
    remainingOutput,
    onOutputChunk: (chunk: Buffer, stream: CommandOutputStream): void => {
      if (closed || signal?.aborted || (!phase && stream === "stdout")) {
        return;
      }
      capture?.(chunk, stream);
      // A display sink failure must not cancel a Doctor holding admitted writes.
      try {
        streams[stream].append(chunk);
      } catch {
        /* Retain process/result ownership. */
      }
    },
    finish(result?: { stdout?: unknown; stderr?: unknown }): void {
      if (closed) {
        return;
      }
      closed = true;
      // Keep the existing completion-only operator detail channel. Not every useful
      // Doctor panel is a result warning, and some callers have no warning callback.
      // Redact the whole bounded capture before clipping: never expose a split secret.
      if (phase) {
        for (const stream of ["stdout", "stderr"] as const) {
          const text = result?.[stream];
          if (typeof text !== "string" || !text.trim()) {
            continue;
          }
          try {
            const redacted = redactDoctorOutput(text);
            const detail =
              redacted === undefined
                ? "[Doctor diagnostic output omitted: incomplete private key]"
                : remainingOutput(redacted).trim();
            if (detail) {
              write("update doctor", {
                phase,
                stream,
                detail: truncateUtf8Prefix(detail, 16 * 1024),
                ...(Buffer.byteLength(detail) > 16 * 1024 ? { truncated: true } : {}),
              });
            }
          } catch {
            /* The result channel still owns warnings and failure facts. */
          }
        }
      }
    },
  };
}
