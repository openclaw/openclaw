import type { DatabaseSync } from "node:sqlite";

/** A distinct PostgreSQL-shaped publication identity; SQL still belongs to the fixture's SQLite handle. */
export function createSqlPublicationTestConnection(anchor: DatabaseSync): DatabaseSync {
  return new Proxy(anchor, {
    has(target, key) {
      return key === Symbol.for("openclaw.postgres-sync-connection") || Reflect.has(target, key);
    },
    get(target, key) {
      if (key === Symbol.for("openclaw.postgres-sync-connection")) {
        return true;
      }
      if (key === "anchor") {
        return target;
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
