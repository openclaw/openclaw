import { statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  readOpenClawAgentDatabaseIdentity,
  registerOpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import {
  assertSessionEntryCreationPublication,
  withSessionEntryCreationPublication,
} from "./session-accessor.sqlite-entry-cache-publication.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

afterEach(() => vi.restoreAllMocks());
const directories = useAutoCleanupTempDirTracker(afterEach);

it.each([
  { name: "drive", runtimePath: String.raw`C:\OpenClaw\agents\main\agent.sqlite` },
  { name: "UNC", runtimePath: String.raw`\\Server\Share\OpenClaw\agents\main\agent.sqlite` },
  {
    name: "long drive",
    runtimePath: path.win32.join(
      "C:\\OpenClaw",
      ...Array(20).fill("long-directory"),
      "agent.sqlite",
    ),
  },
])(
  "retains creation publication custody across $name namespace aliases",
  async ({ runtimePath }) => {
    const databasePath = path.join(
      directories.make("session-publication-windows-"),
      "agent.sqlite",
    );
    const database = new DatabaseSync(databasePath);
    const metadata = statSync(databasePath, { bigint: true });
    const namespacedPath = path.win32.toNamespacedPath(runtimePath);
    const target = {
      agentId: "main",
      sessionKey: "agent:main:windows-publication",
      paths: new Set([path.win32.resolve(runtimePath)]),
    };
    const resolveWindowsPath = path.win32.resolve;
    try {
      mockProcessPlatform("win32");
      vi.spyOn(path, "resolve").mockImplementation(resolveWindowsPath);
      vi.spyOn(database, "location").mockReturnValue(namespacedPath);
      // Model the Windows native boundary while preserving the real handle's physical identity.
      vi.mocked(statSync).mockReturnValueOnce(metadata);
      registerOpenClawAgentDatabaseIdentity(database);
      const identity = readOpenClawAgentDatabaseIdentity({ db: database });
      if (typeof identity.identity !== "string") {
        throw new Error("Expected a file-backed creation publication fixture");
      }
      const operation = await withSessionEntryCreationPublication(
        {
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          file: {
            path: identity.filename,
            agentId: target.agentId,
            databaseIdentity: identity.identity,
            assertCurrent: () => {
              expect(database.isOpen).toBe(true);
            },
          },
        },
        async (current) => {
          expect(() => assertSessionEntryCreationPublication(current, target)).not.toThrow();
          expect(() =>
            assertSessionEntryCreationPublication(current, {
              ...target,
              paths: new Set([path.win32.join(path.win32.dirname(runtimePath), "other.sqlite")]),
            }),
          ).toThrow("Session creation publication owner is no longer current");
          return current;
        },
      );
      expect(() => assertSessionEntryCreationPublication(operation, target)).toThrow(
        "Session creation publication owner is no longer current",
      );
    } finally {
      vi.restoreAllMocks();
      database.close();
    }
  },
);
