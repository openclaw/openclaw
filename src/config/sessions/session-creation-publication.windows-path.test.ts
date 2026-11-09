import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, assert, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  readOpenClawAgentDatabaseIdentity,
  registerOpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import {
  assertSessionEntryCreationPublication as assertPublication,
  withSessionEntryCreationPublication as withPublication,
} from "./session-accessor.sqlite-entry-cache-publication.js";

// A shared worker may already hold the identity owner with its real filesystem imports.
vi.hoisted(() => vi.resetModules());
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});
const directories = createTempDirTracker();
let databasePath: string;
let db: DatabaseSync;
beforeEach(() => {
  databasePath = path.join(directories.make("session-publication-"), "agent.sqlite");
  db = new DatabaseSync(databasePath);
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  directories.cleanup();
});
const publication = (...args: Parameters<typeof assertPublication>) =>
  expect(() => assertPublication(...args));
const expired = "Session creation publication owner is no longer current";
const drive = String.raw`C:\OpenClaw\agents\main\agent.sqlite`;
const scope = { agentId: "main", sessionKey: "agent:main:publication" };
it.each([
  ["native", undefined, undefined],
  ["drive", drive, undefined],
  ["UNC", String.raw`\\Server\Share\OpenClaw\agents\main\agent.sqlite`, undefined],
  ["junction", drive, String.raw`C:\agent-alias\agent.sqlite`],
  [
    "long drive",
    path.win32.join("C:\\OpenClaw", ...Array(20).fill("long-directory"), "agent.sqlite"),
    undefined,
  ],
] as const)(
  "binds %s publication to its physical identity and lifetime",
  async (_name, runtimePath, openedPath = runtimePath) => {
    const target = {
      ...scope,
      paths: new Set([runtimePath ? path.win32.resolve(runtimePath) : databasePath]),
    };
    if (runtimePath) {
      const metadata = statSync(databasePath, { bigint: true });
      // On Windows, path and path.win32 share the method that spyOn replaces.
      const resolveWindowsPath = path.win32.resolve;
      mockProcessPlatform("win32");
      vi.spyOn(path, "resolve").mockImplementation(resolveWindowsPath);
      vi.spyOn(db, "location").mockReturnValue(
        path.win32.toNamespacedPath(openedPath ?? runtimePath),
      );
      vi.spyOn(realpathSync, "native").mockReturnValue(path.win32.toNamespacedPath(runtimePath));
      vi.mocked(statSync).mockReturnValueOnce(metadata).mockReturnValueOnce(metadata);
    }
    registerOpenClawAgentDatabaseIdentity(db);
    const identity = readOpenClawAgentDatabaseIdentity({ db });
    assert(
      typeof identity.identity === "string",
      "Expected a file-backed creation publication fixture",
    );
    const file = {
      path: identity.canonicalPath,
      agentId: scope.agentId,
      databaseIdentity: identity.identity,
      assertCurrent: () => expect(db.isOpen).toBe(true),
    };
    const source = runtimePath
      ? { file }
      : { database: { agentId: scope.agentId, path: databasePath, db } };
    const valid = runtimePath
      ? target
      : {
          ...target,
          paths: new Set<string>(),
          databaseIdentity: `file:${identity.identity}`,
        };
    const invalid = runtimePath
      ? {
          ...target,
          paths: new Set([path.win32.join(path.win32.dirname(runtimePath), "other.sqlite")]),
        }
      : { ...target, databaseIdentity: "file:0:0" };
    const operation = await withPublication({ ...source, ...scope }, async (current) => {
      publication(current, valid).not.toThrow();
      publication(current, invalid).toThrow(expired);
      return current;
    });
    publication(operation, target).toThrow(expired);
  },
);
