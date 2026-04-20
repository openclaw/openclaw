/**
 * Gateway server method: agent.identity.full
 *
 * Returns the local OpenClaw agent's FULL identity (parsed frontmatter
 * plus raw IDENTITY.md / SOUL.md content) so that external clients
 * (e.g. agent-federation) do NOT need to read these files directly
 * from the filesystem. Keeps the workspace as the single source of
 * truth and lets OpenClaw mediate access.
 *
 * Compare with the existing `agent.identity.get` (in agent.ts) which
 * returns only the UI-facing subset (name, avatar, emoji). This method
 * exposes everything needed to build agent system prompts and perform
 * DID-based peer identification.
 *
 * Registered under READ_SCOPE — any operator with read access can
 * fetch agent identity.
 */

import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";

import { ErrorCodes, errorShape } from "../protocol/index.js";
import { formatError } from "../server-utils.js";
import type { GatewayRequestHandlers } from "./types.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface IdentityPayload {
  /** true if IDENTITY.md was found and parsed */
  available: boolean;
  /** Reason when available === false (e.g. "no_workspace", "no_identity_md") */
  reason?: string;
  /** Absolute path to the workspace we resolved (for debugging). */
  workspacePath?: string;

  // Parsed from YAML frontmatter of IDENTITY.md
  name?: string;
  did?: string;
  emoji?: string;
  creature?: string;
  vibe?: string;

  // Raw file contents for callers that want to re-parse (e.g. build
  // system prompts that include SOUL).
  identityRaw?: string;
  soulRaw?: string;
}

// ─── Workspace resolution ─────────────────────────────────────────────────

/**
 * Resolve the OpenClaw workspace path.
 * Priority: OPENCLAW_WORKSPACE env → ~/.openclaw/workspace
 */
function resolveWorkspacePath(): string {
  const envPath = process.env.OPENCLAW_WORKSPACE;
  if (envPath && envPath.length > 0) return envPath;
  return path.join(os.homedir(), ".openclaw", "workspace");
}

// ─── YAML frontmatter parser ──────────────────────────────────────────────

/**
 * Very small YAML frontmatter parser.
 *
 * Accepts documents that begin with `---\n...\n---\n` and returns the
 * parsed key-value pairs (string values only) plus the remaining body.
 *
 * Intentionally minimal — OpenClaw already has a richer YAML parser
 * elsewhere but we avoid a new dependency in the Gateway path.
 */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  if (!raw.startsWith("---")) return { meta, body: raw };

  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { meta, body: raw };

  const fm = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\n+/, "");

  for (const line of fm.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();

    // Strip matching quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key.length > 0) meta[key] = value;
  }

  return { meta, body };
}

// ─── Reader ────────────────────────────────────────────────────────────────

async function readIdentity(workspacePath: string): Promise<IdentityPayload> {
  try {
    const stat = await fs.stat(workspacePath).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      return { available: false, reason: "no_workspace", workspacePath };
    }

    const identityPath = path.join(workspacePath, "IDENTITY.md");
    const soulPath = path.join(workspacePath, "SOUL.md");

    let identityRaw: string;
    try {
      identityRaw = await fs.readFile(identityPath, "utf-8");
    } catch {
      return { available: false, reason: "no_identity_md", workspacePath };
    }

    let soulRaw = "";
    try {
      soulRaw = await fs.readFile(soulPath, "utf-8");
    } catch {
      // SOUL.md is optional
      soulRaw = "";
    }

    const { meta } = parseFrontmatter(identityRaw);

    return {
      available: true,
      workspacePath,
      name: meta.name,
      did: meta.did,
      emoji: meta.emoji,
      creature: meta.creature,
      vibe: meta.vibe,
      identityRaw,
      soulRaw,
    };
  } catch (err) {
    return {
      available: false,
      reason: `read_error: ${formatError(err)}`,
      workspacePath,
    };
  }
}

// ─── Handler ───────────────────────────────────────────────────────────────

export const identityHandlers: GatewayRequestHandlers = {
  "agent.identity.full": async ({ respond }) => {
    try {
      const workspacePath = resolveWorkspacePath();
      const payload = await readIdentity(workspacePath);
      respond(true, payload, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatError(err)));
    }
  },
};
