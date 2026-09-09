import { AsyncLocalStorage } from "node:async_hooks";
import { resolveStateDir } from "../../config/paths.js";
import { redactSupportString } from "../../logging/diagnostic-support-redaction.js";
import type { CommandOutputStream } from "../../process/exec-output.js";
import { truncateUtf8Prefix, truncateUtf8Suffix } from "../../utils/utf8-truncate.js";

const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_EXCERPT_BYTES = 256;
const outputScope = new AsyncLocalStorage<UpdateFinalizationOutput>();

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
    const withoutCompleteKeys = text.replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
      "",
    );
    if (withoutCompleteKeys.includes("PRIVATE KEY-----")) {
      return { ...facts, omitted: "incomplete-private-key" as const };
    }
    try {
      const redacted = redactSupportString(
        text,
        { env: process.env, stateDir: resolveStateDir() },
        { maxLength: Number.MAX_SAFE_INTEGER },
      );
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
    if (!this.doctor) {
      return undefined;
    }
    return {
      phase: this.doctor.phase,
      stdout: this.doctor.stdout.snapshot(),
      stderr: this.doctor.stderr.snapshot(),
    };
  }

  close(): void {
    this.closed = true;
    this.doctor = undefined;
  }
}

export function captureUpdateFinalizationDoctorOutput(phase: "pre-plugin" | "post-plugin") {
  return outputScope.getStore()?.captureDoctor(phase);
}
