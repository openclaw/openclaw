/**
 * Context Atoms — vector-retrieved workspace knowledge.
 *
 * Instead of loading entire 26KB files into the system prompt,
 * this retrieves only the most relevant ~2KB of atomic chunks
 * via sqlite-vec semantic search.
 *
 * Data source: Time Tunnel context_atoms + context_atom_vectors tables.
 */

import { existsSync } from "fs";
import path from "path";
const MAX_OUTPUT_CHARS = 2000;
const CACHE_TTL_MS = 3 * 60 * 1000;

let cachedAtoms: { text: string; expiresAt: number; key: string } | null = null;
let timeTunnelModule: {
  retrieveContextAtoms: (
    query: string,
    opts?: { limit?: number; minScore?: number },
  ) => Array<{ source_file: string; heading: string; content: string; similarity: number }>;
} | null = null;

async function loadTimeTunnel(workspaceDir: string) {
  if (timeTunnelModule) return timeTunnelModule;
  try {
    const queryPath = path.join(workspaceDir, "hooks/time-tunnel/query.js");
    if (!existsSync(queryPath)) return null;
    const mod = await import(queryPath);
    if (typeof mod.retrieveContextAtoms !== "function") return null;
    timeTunnelModule = { retrieveContextAtoms: mod.retrieveContextAtoms };
    return timeTunnelModule;
  } catch (err) {
    console.warn("[context-atoms] loadTimeTunnel failed:", (err as Error).message);
    return null;
  }
}

function formatAtoms(
  atoms: Array<{ source_file: string; heading: string; content: string; similarity: number }>,
): string {
  if (atoms.length === 0) return "";

  const lines: string[] = ["[Context — relevant workspace knowledge]"];
  let totalChars = lines[0].length;

  for (const atom of atoms) {
    const entry = `[${atom.source_file}/${atom.heading}] ${atom.content}`;
    if (totalChars + entry.length + 2 > MAX_OUTPUT_CHARS) break;
    lines.push(entry);
    totalChars += entry.length + 1;
  }

  lines.push("[/Context]");
  return lines.join("\n");
}

/**
 * Retrieve relevant context atoms for the current message.
 * Returns formatted string for injection as a context segment.
 */
export async function buildContextAtoms(
  workspaceDir: string,
  messageBody: string,
  senderName?: string,
): Promise<string> {
  // Cache check
  const cacheKey = (senderName || "") + messageBody.slice(0, 80);
  if (cachedAtoms && Date.now() < cachedAtoms.expiresAt && cachedAtoms.key === cacheKey) {
    return cachedAtoms.text;
  }

  try {
    const mod = await loadTimeTunnel(workspaceDir);
    if (!mod) return "";

    // Build query from message + sender context
    const query = senderName ? `${senderName} ${messageBody}` : messageBody;

    const atoms = mod.retrieveContextAtoms(query, { limit: 8, minScore: 0.15 });
    if (atoms.length === 0) return "";

    const text = formatAtoms(atoms);

    // Cache
    cachedAtoms = { text, expiresAt: Date.now() + CACHE_TTL_MS, key: cacheKey };
    return text;
  } catch (err) {
    console.warn("[context-atoms] buildContextAtoms error:", (err as Error).message);
    return "";
  }
}
