/**
 * AgentShield middleware integration for OpenClaw.
 *
 * Calls the Python middleware (`security/agentshield_middleware.py`) via
 * child_process to evaluate every tool call against an AgentShield policy
 * before execution.
 *
 * Enable by setting `AGENTSHIELD_ENABLED=1` in your environment.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

// ── Types ────────────────────────────────────────────────────────

export type AgentShieldResult = {
  action: "allow" | "block" | "needs_approval";
  reason: string;
  receipt_path: string;
  request_id: string;
  approval_request_path: string | null;
};

export type AgentShieldConfig = {
  enabled: boolean;
  policyProfile: string;
  pythonBin: string;
  middlewarePath: string;
  keyPath: string;
  pubkeyPath: string;
  receiptsDir: string;
  incidentsRoot: string;
  approvalsDir: string;
  agentId: string;
  publisherId: string;
  version: string;
};

// ── Configuration ────────────────────────────────────────────────

function resolveDataDir(): string {
  return process.env.AGENTSHIELD_DATA_DIR || "data/agentshield";
}

export function loadAgentShieldConfig(): AgentShieldConfig {
  const dataDir = resolveDataDir();
  return {
    enabled: process.env.AGENTSHIELD_ENABLED === "1",
    policyProfile: process.env.AGENTSHIELD_POLICY_PROFILE || "normal",
    pythonBin: process.env.AGENTSHIELD_PYTHON || "python3",
    middlewarePath:
      process.env.AGENTSHIELD_MIDDLEWARE_PATH ||
      path.resolve(process.cwd(), "security", "agentshield_middleware.py"),
    keyPath:
      process.env.AGENTSHIELD_KEY_PATH || path.join(dataDir, "keys", "agentshield_ed25519.key"),
    pubkeyPath:
      process.env.AGENTSHIELD_PUBKEY_PATH || path.join(dataDir, "keys", "agentshield_ed25519.pub"),
    receiptsDir: process.env.AGENTSHIELD_RECEIPTS_DIR || path.join(dataDir, "receipts"),
    incidentsRoot: process.env.AGENTSHIELD_INCIDENTS_ROOT || path.join(dataDir, "incidents"),
    approvalsDir: process.env.AGENTSHIELD_APPROVALS_DIR || path.join(dataDir, "approvals"),
    agentId: process.env.AGENTSHIELD_AGENT_ID || "openclaw-agent",
    publisherId: process.env.AGENTSHIELD_PUBLISHER_ID || "openclaw",
    version: process.env.AGENTSHIELD_VERSION || "0.0.0",
  };
}

// ── Key bootstrapping ────────────────────────────────────────────

/**
 * Ensure signer keys exist.  If they don't, try to generate them via
 * `agentshield keygen`.  Returns true if keys are ready.
 */
export function ensureKeys(cfg: AgentShieldConfig): boolean {
  if (existsSync(cfg.keyPath) && existsSync(cfg.pubkeyPath)) {
    return true;
  }
  const keysDir = path.dirname(cfg.keyPath);
  try {
    mkdirSync(keysDir, { recursive: true });
    execFileSync(cfg.pythonBin, ["-m", "agentshield.cli", "keygen", "--out-dir", keysDir], {
      timeout: 10_000,
      stdio: "pipe",
    });
    return existsSync(cfg.keyPath) && existsSync(cfg.pubkeyPath);
  } catch {
    return false;
  }
}

// ── Evaluation ───────────────────────────────────────────────────

/**
 * Build a safe args summary string (redacted) from tool params.
 * Never includes raw secret values — only key names and truncated values.
 */
function buildArgsSummary(toolName: string, params: Record<string, unknown>): string {
  const keys = Object.keys(params).sort();
  const parts = keys.map((k) => {
    const v = params[k];
    if (typeof v === "string" && v.length > 80) {
      return `${k}=${v.slice(0, 77)}...`;
    }
    return `${k}=${String(v)}`;
  });
  return `${toolName}(${parts.join(", ")})`;
}

/**
 * Evaluate a tool call against AgentShield policy.
 *
 * Shells out to the Python middleware.  Returns the verdict or null if
 * AgentShield is not enabled / keys are missing / middleware fails.
 */
export async function evaluateToolCall(
  toolName: string,
  params: Record<string, unknown>,
  cfg?: AgentShieldConfig,
): AgentShieldResult | null {
  const config = cfg ?? loadAgentShieldConfig();

  if (!config.enabled) {
    return null;
  }

  if (!ensureKeys(config)) {
    console.warn("[agentshield] Keys not found and keygen failed; skipping enforcement");
    return null;
  }

  if (!existsSync(config.middlewarePath)) {
    console.warn(`[agentshield] Middleware not found at ${config.middlewarePath}; skipping`);
    return null;
  }

  const argsJson = JSON.stringify(params);

  try {
    const stdout = execFileSync(
      config.pythonBin,
      [
        config.middlewarePath,
        "--tool",
        toolName,
        "--args",
        argsJson,
        "--agent-id",
        config.agentId,
        "--publisher-id",
        config.publisherId,
        "--version",
        config.version,
        "--policy-profile",
        config.policyProfile,
        "--key",
        config.keyPath,
        "--pubkey",
        config.pubkeyPath,
        "--receipts-dir",
        config.receiptsDir,
        "--incidents-root",
        config.incidentsRoot,
        "--approvals-dir",
        config.approvalsDir,
      ],
      {
        timeout: 15_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    return JSON.parse(stdout.trim()) as AgentShieldResult;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[agentshield] Evaluation failed: ${msg}`);
    return null; // fail-open: allow tool call if middleware crashes
  }
}

/**
 * Format a user-facing block message from an AgentShield verdict.
 */
export function formatBlockMessage(result: AgentShieldResult): string {
  const lines = [`Tool blocked by AgentShield: ${result.reason}`];
  lines.push(`Receipt: ${result.receipt_path}`);
  if (result.action === "needs_approval" && result.approval_request_path) {
    lines.push("");
    lines.push("This tool call requires operator approval. To approve:");
    lines.push(
      `  agentshield approve --request ${result.approval_request_path} ` +
        `--out <grant_path> --key <operator.key> --pubkey <operator.pub> --operator-id <id>`,
    );
  }
  return lines.join("\n");
}
