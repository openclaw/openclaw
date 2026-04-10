// Octopus Orchestrator — PendingLog sidecar (M4-05)
//
// Per-node unacked-transition log persisted at
// `~/.openclaw/octo/node-<nodeId>/pending.jsonl`. Node Agents append
// state transitions here before sending them over the wire. On
// reconnect the log is replayed so the Head receives every transition
// at least once. The Head acks each transition by ID; the Node Agent
// then removes the acked entry via `ack()`.
//
// Context docs:
//   - LLD SS Storage Choices -- pending.jsonl path
//   - LLD SS Node Agent Internals -- replay-on-reconnect contract
//   - src/octo/head/event-log.ts -- JSONL append pattern reference
//
// Boundary discipline (OCTO-DEC-033):
//   Only `node:*` builtins and relative imports inside `src/octo/`.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

// ======================================================================
// PendingTransition
// ======================================================================

export interface PendingTransition {
  id: string; // unique ID for ack
  arm_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  ts: number;
}

// ======================================================================
// PendingLog
// ======================================================================

const DIR_MODE = 0o700;

export class PendingLog {
  constructor(private readonly path: string) {}

  /**
   * Append a transition to the log. Generates a unique `id` via
   * `crypto.randomUUID()`, writes one JSONL line, and returns the
   * complete record including the generated ID.
   */
  async append(transition: Omit<PendingTransition, "id">): Promise<PendingTransition> {
    const entry: PendingTransition = {
      id: randomUUID(),
      ...transition,
    };

    const parent = dirname(this.path);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true, mode: DIR_MODE });
    }

    await appendFile(this.path, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }

  /**
   * Replay all unacked transitions in file order, calling `handler`
   * once per entry. Returns the number of entries replayed.
   *
   * If the file does not exist or is empty, returns 0.
   */
  async replay(handler: (t: PendingTransition) => void | Promise<void>): Promise<number> {
    if (!existsSync(this.path)) {
      return 0;
    }

    const content = await readFile(this.path, "utf8");
    if (content.trim().length === 0) {
      return 0;
    }

    const lines = content.split("\n").filter((l) => l.length > 0);
    let count = 0;
    for (const line of lines) {
      const entry = JSON.parse(line) as PendingTransition;
      await handler(entry);
      count++;
    }
    return count;
  }

  /**
   * Acknowledge (remove) a single transition by ID. Rewrites the file
   * excluding the acked entry. O(n) but the pending log is expected
   * to be small (< 100 entries).
   */
  async ack(transitionId: string): Promise<void> {
    if (!existsSync(this.path)) {
      return;
    }

    const content = await readFile(this.path, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    const kept = lines.filter((line) => {
      const entry = JSON.parse(line) as PendingTransition;
      return entry.id !== transitionId;
    });

    await writeFile(this.path, kept.length > 0 ? kept.join("\n") + "\n" : "", "utf8");
  }

  /**
   * Truncate the pending log, removing all entries.
   */
  async clear(): Promise<void> {
    const parent = dirname(this.path);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true, mode: DIR_MODE });
    }
    await writeFile(this.path, "", "utf8");
  }
}
