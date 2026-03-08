import { spawn } from "node:child_process";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
// local JSON parse (avoid dependency)

export type OutboundGateContext = {
  // what
  kind: "message";
  action: string;
  channel: string;
  accountId?: string | null;
  target?: string | null;
  threadId?: string | null;
  replyToId?: string | null;
  text?: string | null;
  mediaUrl?: string | null;
  // who/where
  agentId?: string | null;
  sessionKey?: string | null;
  toolContext?: unknown;
  // time
  tsMs: number;
};

export type OutboundGateResult =
  | { allow: true; reason?: string; policyVersion?: string }
  | { allow: false; reason: string; policyVersion?: string };

function coerceCommandArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const arr = value.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean);
  return arr.length > 0 ? arr : null;
}

export async function runOutboundGate(params: {
  cfg: OpenClawConfig;
  ctx: OutboundGateContext;
}): Promise<OutboundGateResult> {
  const gateCfg = params.cfg.tools?.message?.gate;
  if (!gateCfg?.enabled) {
    return { allow: true };
  }

  const mode = gateCfg.mode ?? "fail-closed";
  const cmd = coerceCommandArray(gateCfg.command);
  if (!cmd) {
    if (mode === "fail-open") {
      return { allow: true, reason: "gate missing command (fail-open)" };
    }
    return {
      allow: false,
      reason: "outbound gate enabled but tools.message.gate.command is not set",
    };
  }

  const timeoutMs = Math.max(200, gateCfg.timeoutMs ?? 1500);

  return await new Promise<OutboundGateResult>((resolve) => {
    const [exe, ...args] = cmd;
    if (!exe) {
      resolve({
        allow: mode === "fail-open",
        reason:
          mode === "fail-open"
            ? "gate missing executable (fail-open)"
            : "outbound gate missing executable",
      });
      return;
    }

    const child = spawn(exe, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: gateCfg.env ? { ...process.env, ...gateCfg.env } : process.env,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } finally {
        if (mode === "fail-open") {
          resolve({ allow: true, reason: `gate timeout (fail-open): ${timeoutMs}ms` });
        } else {
          resolve({ allow: false, reason: `outbound gate timeout after ${timeoutMs}ms` });
        }
      }
    }, timeoutMs);

    child.once("error", (err) => {
      clearTimeout(timer);
      if (mode === "fail-open") {
        resolve({ allow: true, reason: `gate error (fail-open): ${String(err)}` });
      } else {
        resolve({ allow: false, reason: `outbound gate error: ${String(err)}` });
      }
    });

    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const reason = `outbound gate exited ${code}: ${stderr.trim() || stdout.trim() || "(no output)"}`;
        if (mode === "fail-open") {
          resolve({ allow: true, reason: `${reason} (fail-open)` });
        } else {
          resolve({ allow: false, reason });
        }
        return;
      }

      let value: unknown = null;
      try {
        value = JSON.parse(stdout.trim()) as unknown;
      } catch {
        value = null;
      }
      if (!value || typeof value !== "object") {
        const reason = `outbound gate returned non-JSON: ${stdout.trim().slice(0, 500)}`;
        if (mode === "fail-open") {
          resolve({ allow: true, reason: `${reason} (fail-open)` });
        } else {
          resolve({ allow: false, reason });
        }
        return;
      }

      const obj = value as Record<string, unknown>;
      const allow = obj.allow;
      const reason = obj.reason;
      const policyVersion = obj.policyVersion;
      if (allow === true) {
        resolve({
          allow: true,
          reason: typeof reason === "string" ? reason : undefined,
          policyVersion,
        });
        return;
      }
      const denyReason =
        typeof reason === "string" && reason.trim() ? reason.trim() : "blocked by outbound gate";
      resolve({ allow: false, reason: denyReason, policyVersion });
    });

    try {
      child.stdin?.write(JSON.stringify({ context: params.ctx }));
      child.stdin?.end();
    } catch {
      // If stdin fails, rely on process exit/error handlers.
    }
  });
}
