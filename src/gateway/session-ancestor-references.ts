import { randomUUID } from "node:crypto";
import type { SessionAncestorRef } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

const MAX_ROWS = 128;
const MAX_CONTENT_CHARS = 128 * 1024;

type DeliveredAncestor = { key: string; content: string; revision: string };

/** Connection-owned, bounded history of exactly the presented wire content. */
export class SessionAncestorReferences {
  readonly #rows = new Map<string, DeliveredAncestor>();
  #chars = 0;

  forget(key: string): void {
    for (const [identity, row] of this.#rows) {
      if (row.key === key) {
        this.#delete(identity);
      }
    }
  }

  #delete(identity: string): void {
    const previous = this.#rows.get(identity);
    if (previous) {
      this.#chars -= previous.content.length;
      this.#rows.delete(identity);
    }
  }

  prepare(rows: GatewaySessionRow[]) {
    const ancestorSessions: GatewaySessionRow[] = [];
    const ancestorSessionRefs: SessionAncestorRef[] = [];
    let updates: Map<string, DeliveredAncestor | undefined> | undefined;
    for (const row of rows) {
      const snapshotAt = row.snapshotAt;
      const identity = JSON.stringify([row.agentId, row.key]);
      let serialized: string;
      if (snapshotAt === undefined) {
        serialized = JSON.stringify(row);
      } else {
        // Fresh viewer rows can normalize the clock without widening its numeric
        // field shape. Restore the wire value even when serialization fails.
        row.snapshotAt = 0;
        try {
          serialized = JSON.stringify(row);
        } finally {
          row.snapshotAt = snapshotAt;
        }
      }
      const previous = this.#rows.get(identity);
      if (previous?.content === serialized && snapshotAt !== undefined) {
        ancestorSessionRefs.push({
          key: row.key,
          sessionId: row.sessionId,
          agentId: row.agentId,
          revision: previous.revision,
          snapshotAt,
        });
        continue;
      }
      const revision = randomUUID();
      ancestorSessions.push({ ...row, ancestorRevision: revision });
      (updates ??= new Map()).set(
        identity,
        snapshotAt !== undefined && serialized.length <= MAX_CONTENT_CHARS
          ? { key: row.key, content: serialized, revision }
          : undefined,
      );
    }
    return {
      ancestorSessions,
      ...(ancestorSessionRefs.length ? { ancestorSessionRefs } : {}),
      delivered: () => {
        if (!updates) {
          return;
        }
        for (const [identity, row] of updates) {
          this.#delete(identity);
          if (row) {
            this.#rows.set(identity, row);
            this.#chars += row.content.length;
          }
        }
        while (this.#rows.size > MAX_ROWS || this.#chars > MAX_CONTENT_CHARS) {
          this.#delete(this.#rows.keys().next().value!);
        }
      },
    };
  }
}
