import { createHash, randomUUID } from "node:crypto";
import type {
  SessionAncestorRef,
  SessionRow,
} from "../../packages/gateway-protocol/src/schema/sessions-row.js";

const MAX_ROWS = 128;
const MAX_CONTENT_CHARS = 128 * 1024;

type DeliveredAncestor = { key: string; content: string; chars: number; revision: string };

/** Prepare immutable viewer content once, before consulting connection delivery history. */
export function prepareSessionAncestor(row: SessionRow) {
  const serialized = JSON.stringify(row.snapshotAt === undefined ? row : { ...row, snapshotAt: 0 });
  return {
    row,
    identity: JSON.stringify([row.agentId, row.key]),
    content: createHash("sha256").update(serialized).digest("base64url"),
    chars: serialized.length,
  };
}

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
      this.#chars -= previous.chars;
      this.#rows.delete(identity);
    }
  }

  prepare(rows: ReturnType<typeof prepareSessionAncestor>[]) {
    const ancestorSessions: SessionRow[] = [];
    const ancestorSessionRefs: SessionAncestorRef[] = [];
    let updates: Map<string, DeliveredAncestor | undefined> | undefined;
    for (const { row, identity, content, chars } of rows) {
      const snapshotAt = row.snapshotAt;
      const previous = this.#rows.get(identity);
      if (previous?.content === content && snapshotAt !== undefined) {
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
        snapshotAt !== undefined && chars <= MAX_CONTENT_CHARS
          ? { key: row.key, content, chars, revision }
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
            this.#chars += row.chars;
          }
        }
        while (this.#rows.size > MAX_ROWS || this.#chars > MAX_CONTENT_CHARS) {
          this.#delete(this.#rows.keys().next().value!);
        }
      },
    };
  }
}
