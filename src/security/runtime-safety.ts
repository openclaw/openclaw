/**
 * Runtime safety utilities for OpenClaw.
 *
 * 1. Transcript retention — configurable auto-purge of old session files
 * 2. Tool call budget — limits tool calls per session to prevent runaway agents
 * 3. Channel token reuse detection — audit check for duplicate tokens
 */

import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { SecurityAuditFinding } from "./audit.js";

// =========================================================================
// 1. Transcript retention
// =========================================================================

export interface RetentionResult {
  scannedFiles: number;
  deletedFiles: number;
  deletedPaths: string[];
  errors: string[];
}

/**
 * Purge session transcript files older than maxAgeDays.
 * Only deletes .jsonl files in the sessions directory.
 */
export function purgeOldTranscripts(sessionsDir: string, maxAgeDays: number): RetentionResult {
  const result: RetentionResult = {
    scannedFiles: 0,
    deletedFiles: 0,
    deletedPaths: [],
    errors: [],
  };

  if (maxAgeDays <= 0) {
    return result;
  }

  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }

    result.scannedFiles++;
    const filePath = path.join(sessionsDir, entry.name);

    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoffMs) {
        fs.unlinkSync(filePath);
        result.deletedFiles++;
        result.deletedPaths.push(filePath);
      }
    } catch (err: unknown) {
      result.errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

// =========================================================================
// 2. Tool call budget
// =========================================================================

export class ToolCallBudgetExceeded extends Error {
  constructor(
    public readonly limit: number,
    public readonly current: number,
  ) {
    super(`Tool call budget exceeded: ${current}/${limit} calls used.`);
    this.name = "ToolCallBudgetExceeded";
  }
}

/**
 * Tracks tool call count per session and enforces a configurable limit.
 * Resets when a new session starts.
 */
export class ToolCallBudget {
  private counts = new Map<string, number>();
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  /**
   * Increment the tool call count for a session.
   * Throws ToolCallBudgetExceeded if the limit is reached.
   */
  check(sessionKey: string): void {
    if (this.limit <= 0) {
      return;
    }
    const current = (this.counts.get(sessionKey) ?? 0) + 1;
    this.counts.set(sessionKey, current);

    if (current > this.limit) {
      throw new ToolCallBudgetExceeded(this.limit, current);
    }
  }

  getCount(sessionKey: string): number {
    return this.counts.get(sessionKey) ?? 0;
  }

  reset(sessionKey: string): void {
    this.counts.delete(sessionKey);
  }

  resetAll(): void {
    this.counts.clear();
  }
}

// =========================================================================
// 3. Channel token reuse detection (audit)
// =========================================================================

function looksLikeEnvRef(value: string): boolean {
  const v = value.trim();
  return v.startsWith("${") && v.endsWith("}");
}

/**
 * Detects when the same token/password value is used across multiple
 * channel configurations. Reusing tokens is a misconfiguration risk —
 * revoking one channel's token would break all channels sharing it.
 */
export function collectChannelTokenReuseFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const channels = cfg.channels;
  if (!channels || typeof channels !== "object") {
    return findings;
  }

  const tokenMap = new Map<string, string[]>();

  const channelSecretFields: Array<{ channel: string; fields: string[] }> = [
    { channel: "telegram", fields: ["botToken"] },
    { channel: "discord", fields: ["token"] },
    { channel: "slack", fields: ["botToken", "appToken"] },
    { channel: "signal", fields: ["password"] },
    { channel: "msteams", fields: ["appPassword"] },
    { channel: "mattermost", fields: ["password"] },
  ];

  for (const { channel, fields } of channelSecretFields) {
    const channelCfg = (channels as Record<string, unknown>)[channel];
    if (!channelCfg || typeof channelCfg !== "object") {
      continue;
    }
    for (const field of fields) {
      const value = (channelCfg as Record<string, unknown>)[field];
      if (typeof value !== "string" || !value.trim() || looksLikeEnvRef(value)) {
        continue;
      }
      const path = `channels.${channel}.${field}`;
      const existing = tokenMap.get(value) ?? [];
      existing.push(path);
      tokenMap.set(value, existing);
    }
  }

  for (const [, paths] of tokenMap) {
    if (paths.length > 1) {
      findings.push({
        checkId: "credentials.token_reuse_across_channels",
        severity: "warn",
        title: "Same token used across multiple channels",
        detail: `The same credential value is used at: ${paths.join(", ")}. Revoking one would break all.`,
        remediation: "Use a unique token for each channel to limit blast radius.",
      });
    }
  }

  return findings;
}
