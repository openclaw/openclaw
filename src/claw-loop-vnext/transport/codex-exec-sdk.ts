import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { LoopTransport, SendMessageRequest, SendMessageResult } from "./types.js";

type JsonEvent = Record<string, unknown>;

function toAckId(event: JsonEvent): string {
  const idCandidate = event.id;
  if (typeof idCandidate === "string" && idCandidate.trim()) {
    return idCandidate;
  }
  const digest = createHash("sha256").update(JSON.stringify(event)).digest("hex");
  return digest.slice(0, 16);
}

function extractTextFromEvent(event: JsonEvent): string | undefined {
  const text = event.text;
  if (typeof text === "string") {
    return text;
  }

  const message = event.message;
  if (typeof message === "string") {
    return message;
  }

  const content = event.content;
  if (typeof content === "string") {
    return content;
  }

  return undefined;
}

export class CodexExecSdkTransport implements LoopTransport {
  readonly kind = "sdk" as const;

  async sendMessage(request: SendMessageRequest): Promise<SendMessageResult> {
    const args = [
      "exec",
      "--json",
      "--cd",
      request.workdir,
      "--sandbox",
      "danger-full-access",
      "--ask-for-approval",
      "never",
      "-",
    ];

    const child = spawn("codex", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CLAW_LOOP_IDEMPOTENCY_KEY: request.idempotencyKey,
      },
    });

    const outputText: string[] = [];
    const stderrText: string[] = [];
    let delivered = false;
    let ackId: string | undefined;

    let stdoutBuffer = "";
    const ackTimer = setTimeout(() => {
      if (!delivered) {
        child.kill("SIGTERM");
      }
    }, request.ackTimeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      while (true) {
        const idx = stdoutBuffer.indexOf("\n");
        if (idx < 0) {
          break;
        }
        const line = stdoutBuffer.slice(0, idx).trim();
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        if (!line) {
          continue;
        }
        try {
          const event = JSON.parse(line) as JsonEvent;
          if (!delivered) {
            delivered = true;
            ackId = toAckId(event);
          }
          const text = extractTextFromEvent(event);
          if (text) {
            outputText.push(text);
          }
        } catch {
          // If codex prints plain text unexpectedly, keep it for downstream parsing.
          outputText.push(line);
          if (!delivered) {
            delivered = true;
            ackId = createHash("sha1").update(line).digest("hex").slice(0, 16);
          }
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrText.push(chunk.toString("utf8"));
    });

    child.stdin.write(request.message);
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
    });

    clearTimeout(ackTimer);

    const stderr = stderrText.join("").trim();
    if (!delivered) {
      return {
        delivered: false,
        transport: this.kind,
        outputText: outputText.join("\n"),
        reason: stderr || `codex exec exited before ACK (code=${String(exitCode)})`,
      };
    }

    return {
      delivered: true,
      transport: this.kind,
      ackId,
      outputText: outputText.join("\n"),
      reason: exitCode === 0 ? undefined : stderr || `codex exec exit code ${String(exitCode)}`,
    };
  }
}
