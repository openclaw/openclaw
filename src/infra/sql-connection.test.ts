import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { sqlPublicationAnchor, type PostgresSqlConnection } from "./sql-connection.js";

it("uses the SQLite handle and the PostgreSQL anchor as publication identities", () => {
  const anchor = new DatabaseSync(":memory:");
  try {
    const postgres: PostgresSqlConnection = {
      anchor,
      mutationRevision: 0,
      advisoryLockKey: 0n,
      isOpen: true,
      isTransaction: false,
      prepare: vi.fn(),
      exec: vi.fn(),
      close: vi.fn(),
      query: vi.fn(),
      runTransaction: (operation) => operation(),
    };
    Object.defineProperty(postgres, Symbol.for("openclaw.postgres-sync-connection"), {
      value: true,
    });

    expect(sqlPublicationAnchor(anchor)).toBe(anchor);
    expect(sqlPublicationAnchor(postgres)).toBe(anchor);
  } finally {
    anchor.close();
  }
});
