import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  readOpenClawAgentDatabaseIdentity,
  registerOpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import {
  assertSessionEntryCreationPublication,
  withSessionEntryCreationPublication,
} from "./session-accessor.sqlite-entry-cache-publication.js";

// A shared worker may already hold the identity owner with its real filesystem imports.
vi.hoisted(() => vi.resetModules());
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

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
const directories = createTempDirTracker();
const publication = (...args: Parameters<typeof assertSessionEntryCreationPublication>) =>
  expect(() => assertSessionEntryCreationPublication(...args));
const expired = "Session creation publication owner is no longer current";
const drive = String.raw`C:\OpenClaw\agents\main\agent.sqlite`;
const targetFor = (pathname: string) => ({
  agentId: "main",
  sessionKey: "agent:main:publication",
  paths: new Set([pathname]),
});
function registeredIdentity() {
  registerOpenClawAgentDatabaseIdentity(db);
  const identity = readOpenClawAgentDatabaseIdentity({ db });
  if (typeof identity.identity !== "string") {
    throw new Error("Expected a file-backed creation publication fixture");
  }
  return { ...identity, identity: identity.identity };
}

it("binds a native creation to its prepared physical identity", async () => {
  const database = { agentId: "main", path: databasePath, db };
  const target = targetFor(databasePath);
  const { identity } = registeredIdentity();
  await withSessionEntryCreationPublication(
    { agentId: target.agentId, sessionKey: target.sessionKey, database },
    async (operation) => {
      publication(operation, {
        ...target,
        paths: new Set(),
        databaseIdentity: `file:${identity}`,
      }).not.toThrow();
      publication(operation, {
        ...target,
        databaseIdentity: "file:0:0",
      }).toThrow(expired);
    },
  );
});

it.each([
  ["drive", drive],
  ["UNC", String.raw`\\Server\Share\OpenClaw\agents\main\agent.sqlite`],
  ["junction", drive, String.raw`C:\agent-alias\agent.sqlite`],
  [
    "long drive",
    path.win32.join("C:\\OpenClaw", ...Array(20).fill("long-directory"), "agent.sqlite"),
  ],
])(
  "retains publication across %s namespace aliases",
  async (_name, runtimePath, openedPath = runtimePath) => {
    const metadata = statSync(databasePath, { bigint: true });
    const namespacedPath = path.win32.toNamespacedPath(openedPath);
    const target = targetFor(path.win32.resolve(runtimePath));
    const resolveWindowsPath = path.win32.resolve;
    mockProcessPlatform("win32");
    vi.spyOn(path, "resolve").mockImplementation(resolveWindowsPath);
    vi.spyOn(db, "location").mockReturnValue(namespacedPath);
    // Model the Windows native boundary while preserving the real handle's physical identity.
    vi.spyOn(realpathSync, "native").mockReturnValue(path.win32.toNamespacedPath(runtimePath));
    vi.mocked(statSync).mockReturnValueOnce(metadata).mockReturnValueOnce(metadata);
    const identity = registeredIdentity();
    const operation = await withSessionEntryCreationPublication(
      {
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        file: {
          path: identity.canonicalPath,
          agentId: target.agentId,
          databaseIdentity: identity.identity,
          assertCurrent: () => {
            expect(db.isOpen).toBe(true);
          },
        },
      },
      async (current) => {
        publication(current, target).not.toThrow();
        publication(current, {
          ...target,
          paths: new Set([path.win32.join(path.win32.dirname(runtimePath), "other.sqlite")]),
        }).toThrow(expired);
        return current;
      },
    );
    publication(operation, target).toThrow(expired);
  },
);
