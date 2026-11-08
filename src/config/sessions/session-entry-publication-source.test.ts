import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import type { PostgresSqlConnection } from "../../infra/sql-connection.js";
import {
  captureSessionEntryPublicationSource,
  isSessionEntryPublicationAdmissionCurrent,
  isSessionEntryPublicationSourceCurrent,
  sealSessionEntryPublicationSource,
} from "./session-entry-publication-source.js";

it.each([
  { engine: "PostgreSQL", expectedCurrent: false },
  { engine: "SQLite", expectedCurrent: true },
])(
  "$engine publication without admission facts is current: $expectedCurrent",
  ({ engine, expectedCurrent }) => {
    const anchor = new DatabaseSync(":memory:");
    try {
      const postgres: PostgresSqlConnection = {
        anchor,
        mutationRevision: 0,
        advisoryLockKey: 0n,
        releaseIdleTransport: vi.fn(),
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
      const source = captureSessionEntryPublicationSource(
        engine === "PostgreSQL" ? postgres : anchor,
        {
          identity: `unadmitted-${engine}`,
          birthtime: undefined,
          incarnation: "test",
          filename: `/unadmitted-${engine}/openclaw-agent.sqlite`,
        },
      );

      expect(isSessionEntryPublicationAdmissionCurrent(source)).toBe(expectedCurrent);
      expect(isSessionEntryPublicationSourceCurrent(source)).toBe(expectedCurrent);
      sealSessionEntryPublicationSource(source);
      const transported = structuredClone(source);
      expect(isSessionEntryPublicationAdmissionCurrent(transported)).toBe(expectedCurrent);
      expect(isSessionEntryPublicationSourceCurrent(transported)).toBe(expectedCurrent);
    } finally {
      anchor.close();
    }
  },
);
