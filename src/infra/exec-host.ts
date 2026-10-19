// Sends HMAC-protected exec host requests over the local socket.
import crypto from "node:crypto";
import { addAbortListener } from "node:events";
import net from "node:net";
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";
import {
  addTimerTimeoutGraceMs,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import type { NodePermissionDetails } from "../../packages/gateway-protocol/src/node-permissions.js";
import type { ExecApprovalPolicySnapshot } from "./exec-approvals.js";

// Allow the companion's 15 s approval prompt before execution, then 5 s for its reply.
const EXEC_HOST_RESPONSE_GRACE_MS = 20_000;
const JSONL_SOCKET_MAX_LINE_BYTES = 16 * 1024 * 1024;

// Exec host requests cross the local JSONL socket boundary into a privileged
// runner, so payloads stay explicit and HMAC-protected.
export type ExecHostRequest = {
  command: string[];
  rawCommand?: string | null;
  cwd?: string | null;
  env?: Record<string, string> | null;
  timeoutMs?: number | null;
  needsScreenRecording?: boolean | null;
  agentId?: string | null;
  sessionKey?: string | null;
  approvalDecision?: "allow-once" | "allow-always" | null;
  approvalSource?: "ask-fallback" | "auto-review" | null;
  policySnapshot?: ExecApprovalPolicySnapshot | null;
};

export type ExecHostRunResult = {
  exitCode?: number;
  timedOut: boolean;
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string | null;
};

type ExecHostError = {
  code: string;
  message: string;
  reason?: string;
  details?: NodePermissionDetails;
};

export type ExecHostResponse =
  | { ok: true; payload: ExecHostRunResult }
  | { ok: false; error: ExecHostError };

/** Send an authenticated exec request over the host JSONL socket. */
export async function requestExecHostViaSocket(params: {
  socketPath: string;
  token: string;
  request: ExecHostRequest;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ExecHostResponse | null> {
  const { socketPath, token, request, signal } = params;
  if (!socketPath || !token) {
    return null;
  }
  // Zero disables both command and response deadlines.
  const timeoutMs =
    params.timeoutMs ??
    (request.timeoutMs === 0
      ? 0
      : addTimerTimeoutGraceMs(request.timeoutMs, EXEC_HOST_RESPONSE_GRACE_MS)) ??
    20_000;
  const requestJson = JSON.stringify(request);
  const nonce = crypto.randomBytes(16).toString("hex");
  const ts = Date.now();
  // The host validates the exact JSON payload with nonce and timestamp, so the
  // command body cannot be modified without invalidating the request HMAC.
  const hmac = crypto
    .createHmac("sha256", token)
    .update(`${nonce}:${ts}:${requestJson}`)
    .digest("hex");
  const payload = JSON.stringify({
    type: "exec",
    id: crypto.randomUUID(),
    nonce,
    ts,
    hmac,
    requestJson,
  });

  const responseTimeoutMs = timeoutMs === 0 ? 0 : resolveTimerTimeoutMs(timeoutMs, 1);
  return await new Promise<ExecHostResponse | null>((resolve) => {
    const client = new net.Socket();
    let settled = false;
    let requestSent = false;
    let timer: ReturnType<typeof setNodeTimeout> | undefined;
    // Keep raw bytes until a line is complete so chunk boundaries cannot split
    // a UTF-8 code point before JSON parsing.
    const lineChunks: Buffer[] = [];
    let lineBytes = 0;

    const finish = (value: ExecHostResponse | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearNodeTimeout(timer);
      abortListener?.[Symbol.dispose]();
      client.destroy();
      resolve(value);
    };

    const finishPeerLoss = () =>
      finish(
        requestSent
          ? {
              ok: false,
              error: {
                code: "UNKNOWN",
                reason: "response-lost",
                message:
                  "UNKNOWN: macOS app exec host response was lost; execution outcome is unknown",
              },
            }
          : null,
      );
    const appendLineChunk = (chunk: Buffer): boolean => {
      if (lineBytes + chunk.byteLength > JSONL_SOCKET_MAX_LINE_BYTES) {
        finishPeerLoss();
        return false;
      }
      if (chunk.byteLength > 0) {
        lineChunks.push(chunk);
        lineBytes += chunk.byteLength;
      }
      return true;
    };

    if (responseTimeoutMs > 0) {
      timer = setNodeTimeout(
        () =>
          finish(
            requestSent
              ? {
                  ok: false,
                  error: {
                    code: "TIMEOUT",
                    reason: "timeout",
                    message:
                      "TIMEOUT: macOS app exec host response timed out; execution outcome is unknown",
                  },
                }
              : null,
          ),
        responseTimeoutMs,
      );
    }
    const abortListener = signal ? addAbortListener(signal, () => finish(null)) : undefined;
    // Preparation may have yielded before reaching the transport. Never connect
    // or send for an invocation that has already lost its lifetime.
    if (signal?.aborted) {
      finish(null);
      return;
    }

    client.on("error", finishPeerLoss);
    client.on("end", finishPeerLoss);
    client.on("close", finishPeerLoss);
    client.connect(socketPath, () => {
      if (!settled) {
        requestSent = true;
        client.end(`${payload}\n`);
      }
    });
    client.on("data", (data: Buffer) => {
      let offset = 0;
      while (offset < data.byteLength) {
        const newlineIndex = data.indexOf(0x0a, offset);
        if (newlineIndex === -1) {
          appendLineChunk(data.subarray(offset));
          return;
        }
        // Bound bytes before concatenating or parsing; both complete and unterminated
        // peer-controlled lines must stay below the same allocation ceiling.
        if (!appendLineChunk(data.subarray(offset, newlineIndex))) {
          return;
        }
        const line =
          (lineChunks.length > 1 ? Buffer.concat(lineChunks, lineBytes) : lineChunks[0])
            ?.toString("utf8")
            .trim() ?? "";
        lineChunks.length = 0;
        lineBytes = 0;
        offset = newlineIndex + 1;
        if (!line) {
          continue;
        }
        try {
          const value: unknown = JSON.parse(line);
          const msg = value as { type?: string; ok?: boolean; payload?: unknown; error?: unknown };
          if (msg?.type !== "exec-res") {
            continue;
          }
          if (msg.ok === true && msg.payload) {
            finish({ ok: true, payload: msg.payload as ExecHostRunResult });
            return;
          }
          if (msg.ok === false && msg.error) {
            finish({ ok: false, error: msg.error as ExecHostError });
            return;
          }
        } catch {
          // ignore
        }
      }
    });
  });
}
