import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as boundaryPath from "../infra/boundary-path.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import {
  reconstructAgentDeletionJournal,
  resolveAgentDeletionRecoveryHolds,
} from "./agent-deletion-journal-recovery.js";
import { readAgentDeletionMissingJournalHolds } from "./agent-deletion-journal-recovery.kernel.js";
import {
  resolveOpenClawAgentDatabaseStoredPath,
  resolveOpenClawRegisteredAgentDatabasePath,
} from "./openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

vi.hoisted(() => {
  // The custody runner can preload these owners before the Windows path mock.
  vi.resetModules();
});

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, default: actual.win32 };
});

beforeEach(() => {
  mockProcessPlatform("win32");
  // These locators are synthetic; canonical-root cases supply their own observed root.
  vi.spyOn(boundaryPath, "resolveIdentityPathViaExistingAncestorSync").mockImplementation(
    (root) => root,
  );
});
afterEach(() => vi.restoreAllMocks());

describe("Windows agent database inventory paths", () => {
  it.each([
    {
      stateDir: String.raw`\\kost\share\OpenClaw`,
      canonicalRoot: String.raw`\\kost\share\OpenClaw`,
      agentPath: String.raw`\\Kost\share\OpenClaw\agents\main\agent.sqlite`,
    },
    {
      stateDir: String.raw`\\server\share\OpenClaw`,
      canonicalRoot: String.raw`\\server\share\OpenClaw`,
      agentPath: String.raw`\\?\UNC\server\share\..\..\server\share\OpenClaw\agent.sqlite`,
    },
    {
      stateDir: String.raw`C:\OpenClaw`,
      canonicalRoot: String.raw`C:\OpenClaw`,
      agentPath: String.raw`\\.\C:\..\UNC\server\share\agent.sqlite`,
    },
  ])(
    "retains raw locator identity for $agentPath under $stateDir",
    ({ stateDir, canonicalRoot, agentPath }) => {
      vi.spyOn(boundaryPath, "resolveIdentityPathViaExistingAncestorSync").mockImplementation(
        (root) => {
          expect(root, "only the trusted state root may be probed").toBe(stateDir);
          return canonicalRoot;
        },
      );
      const registry = path.join(stateDir, "state", "openclaw.sqlite");
      const stored = resolveOpenClawAgentDatabaseStoredPath(registry, agentPath);
      expect(stored).toBe(agentPath);
      expect(resolveOpenClawRegisteredAgentDatabasePath(registry, stored)).toBe(agentPath);
    },
  );

  it.each([
    { canonicalRoot: String.raw`D:\Canonical`, relative: String.raw`linked\..\agent.sqlite` },
  ])(
    "relativizes an admitted $relative under canonical root $canonicalRoot",
    ({ canonicalRoot, relative }) => {
      const registry = String.raw`C:\Alias\state\openclaw.sqlite`;
      const resolveRoot = vi.spyOn(boundaryPath, "resolveIdentityPathViaExistingAncestorSync");
      for (const root of [canonicalRoot, path.toNamespacedPath(canonicalRoot)]) {
        resolveRoot.mockReturnValue(root);
        for (const sourceRoot of [canonicalRoot, path.toNamespacedPath(canonicalRoot)]) {
          const candidate = `${sourceRoot}\\${relative}`;
          expect(resolveOpenClawAgentDatabaseStoredPath(registry, candidate)).toBe(relative);
        }
      }
    },
  );

  it("preserves a device namespace without a plain drive/share spelling", () => {
    const registry = String.raw`C:\OpenClaw\state\openclaw.sqlite`;
    const device = String.raw`\\?\Volume{00000000-0000-0000-0000-000000000001}\agent.sqlite`;
    expect(resolveOpenClawAgentDatabaseStoredPath(registry, device)).toBe(device);
  });
});

it("preserves and releases reconstructed holds with Windows registry paths", () => {
  using db = new DatabaseSync(":memory:");
  db.exec(OPENCLAW_STATE_SCHEMA_SQL);
  db.exec("DROP TABLE agent_deletion_journal");
  const database = { db, path: String.raw`C:\Users\operator\.openclaw\state\openclaw.sqlite` };
  const held = ["main", "ayudante", "contador"].map((agentId) => ({
    agentId,
    path: `C:\\Users\\operator\\.openclaw\\agents\\${agentId}\\agent\\openclaw-agent.sqlite`,
  }));
  runSqliteImmediateTransactionSync(db, () => reconstructAgentDeletionJournal(database, held));
  expect(readAgentDeletionMissingJournalHolds(database)).toEqual(held);
  runSqliteImmediateTransactionSync(db, () =>
    resolveAgentDeletionRecoveryHolds(database, "main", [held[0]!.path]),
  );
  expect(readAgentDeletionMissingJournalHolds(database)).toEqual(held.slice(1));
});
