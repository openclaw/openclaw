import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { LoopTransport, SendMessageRequest, SendMessageResult } from "./types.js";

const execFileAsync = promisify(execFile);

async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args, {
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

export class TmuxFallbackTransport implements LoopTransport {
  readonly kind = "tmux" as const;

  async sendMessage(request: SendMessageRequest): Promise<SendMessageResult> {
    const sessionName = request.sessionName || `claw-${request.goalId}`;

    try {
      await tmux("has-session", "-t", sessionName);
    } catch {
      try {
        const payload = [
          "command -v codex >/dev/null 2>&1 || { echo '[claw-loop-vnext] codex not found'; exec bash; }",
          "codex -a never -s danger-full-access",
          "ec=$?",
          "echo",
          'echo "[claw-loop-vnext] codex exited with code: ${ec}"',
          "exec bash",
        ].join("; ");
        await tmux(
          "new-session",
          "-d",
          "-s",
          sessionName,
          "-c",
          request.workdir,
          `bash -lc '${payload}'`,
        );
        await new Promise((resolve) => setTimeout(resolve, 1200));
      } catch (error) {
        return {
          delivered: false,
          transport: this.kind,
          outputText: "",
          reason: `failed creating tmux session ${sessionName}: ${String(error)}`,
        };
      }
    }

    const before = await tmux("capture-pane", "-t", sessionName, "-p", "-S", "-120");
    await tmux("set-buffer", "--", request.message);
    await tmux("paste-buffer", "-t", sessionName);
    await tmux("send-keys", "-t", sessionName, "Enter");

    await new Promise((resolve) => setTimeout(resolve, Math.min(request.ackTimeoutMs, 2000)));

    const after = await tmux("capture-pane", "-t", sessionName, "-p", "-S", "-180");
    const delivered = after !== before;

    return {
      delivered,
      transport: this.kind,
      ackId: delivered ? createHash("sha1").update(after).digest("hex").slice(0, 16) : undefined,
      outputText: after,
      reason: delivered ? undefined : "tmux pane output did not change after send",
    };
  }
}
