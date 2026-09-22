import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";

const { readExactSessionEntryRowMock } = vi.hoisted(() => ({
  readExactSessionEntryRowMock:
    vi.fn<typeof import("./session-accessor.sqlite-entry-store.js").readExactSessionEntryRow>(),
}));

vi.mock("./session-accessor.sqlite-entry-store.js", async () => {
  const actual = await vi.importActual<typeof import("./session-accessor.sqlite-entry-store.js")>(
    "./session-accessor.sqlite-entry-store.js",
  );
  readExactSessionEntryRowMock.mockImplementation(actual.readExactSessionEntryRow);
  return { ...actual, readExactSessionEntryRow: readExactSessionEntryRowMock };
});

const actualSessionEntryStore = await vi.importActual<
  typeof import("./session-accessor.sqlite-entry-store.js")
>("./session-accessor.sqlite-entry-store.js");
const {
  applySessionEntryReplacements,
  assignSessionOwner,
  loadSessionEntry,
  upsertSessionEntryCore,
} = await import("./session-accessor.js");

describe("session entry replacement compare-and-swap", () => {
  const tempDirs: string[] = [];
  let storePath: string;
  let scope: { sessionKey: string; storePath: string };

  beforeEach(async () => {
    readExactSessionEntryRowMock.mockImplementation(
      actualSessionEntryStore.readExactSessionEntryRow,
    );
    storePath = `${makeTempDir(tempDirs, "replacement-cas")}/openclaw-agent.sqlite`;
    scope = { sessionKey: "agent:main:replacement-row", storePath };
    await upsertSessionEntryCore(scope, {
      model: "base",
      sessionId: "replacement-row",
      updatedAt: 10,
    });
  });

  afterEach(() => {
    readExactSessionEntryRowMock.mockReset();
    cleanupTempDirs(tempDirs);
  });

  it.each([false, true])(
    "hydrates replacement candidates once while preserving detached snapshots (status selection: %s)",
    async (selectStatus) => {
      const prompt = "synthetic replacement payload ".repeat(8192);
      for (const suffix of ["a", "b"]) {
        await upsertSessionEntryCore(
          { storePath, sessionKey: `agent:main:payload-${suffix}` },
          {
            sessionId: `payload-${suffix}`,
            updatedAt: 10,
            status: "running",
            skillsSnapshot: { prompt, skills: [] },
          },
        );
      }
      const database = openOpenClawAgentDatabase({ agentId: "main", path: storePath });
      const reads = trackSqliteStatementExecutions(database.db, ["entries"], (sql) =>
        /\bfrom\s+"session_nodes"/iu.test(sql) ? "entries" : null,
      );
      try {
        const result = await applySessionEntryReplacements({
          storePath,
          ...(selectStatus ? { statuses: ["running" as const] } : {}),
          skipMaintenance: true,
          update: (entries) => {
            const selected = entries.filter(({ sessionKey }) => sessionKey.includes("payload-"));
            expect(selected).toHaveLength(2);
            for (const { entry } of selected) {
              expect(entry.skillsSnapshot?.prompt).toBe(prompt);
              if (entry.skillsSnapshot) {
                entry.skillsSnapshot.prompt = "detached mutation";
              }
            }
            return { result: selected.length };
          },
        });
        expect(result).toBe(2);
        // Two full candidate payloads, with room for their small metadata; enumeration must not hydrate them again.
        expect(reads.textBytes.entries).toBeLessThan(prompt.length * 3);
      } finally {
        reads.restore();
      }
      expect(
        loadSessionEntry({ storePath, sessionKey: "agent:main:payload-a" })?.skillsSnapshot?.prompt,
      ).toBe(prompt);
    },
  );

  it.each([
    { mutation: "deleted", expected: undefined },
    {
      mutation: "rewritten",
      expected: expect.objectContaining({
        label: "concurrent-owner-metadata",
        model: "base",
        sessionId: "replacement-row",
      }),
    },
  ])("rejects a row $mutation during its detached snapshot", async ({ mutation, expected }) => {
    readExactSessionEntryRowMock.mockImplementationOnce((database, sessionKey) => {
      const row = actualSessionEntryStore.readExactSessionEntryRow(database, sessionKey);
      if (!row) {
        throw new Error("expected a persisted session row");
      }
      if (mutation === "deleted") {
        database.db.prepare("DELETE FROM session_nodes WHERE session_key = ?").run(sessionKey);
      } else {
        const updatedEntryJson = JSON.stringify({
          ...JSON.parse(row.row.entry_json),
          label: "concurrent-owner-metadata",
        });
        database.db
          .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
          .run(updatedEntryJson, sessionKey);
      }
      return row;
    });

    await expect(
      applySessionEntryReplacements({
        sessionKeys: [scope.sessionKey],
        storePath,
        update: (entries) => ({
          replacements: entries.map(({ entry, sessionKey }) => ({
            entry: { ...entry, model: "stale-replacement" },
            sessionKey,
          })),
          result: undefined,
        }),
      }),
    ).rejects.toThrow("changed before replacement");

    expect(loadSessionEntry({ ...scope, readConsistency: "latest" })).toEqual(expected);
  });

  it("rejects a replacement prepared under a session owner that changes before commit", async () => {
    const assignedBy = { id: "assigner", type: "human" as const };
    assignSessionOwner(scope, {
      assignedBy,
      owner: { id: "owner-a", type: "human" },
    });

    await expect(
      applySessionEntryReplacements({
        sessionKeys: [scope.sessionKey],
        storePath,
        update: (entries) => {
          expect(entries[0]?.entry.owner?.actor.id).toBe("owner-a");
          assignSessionOwner(scope, {
            assignedBy,
            owner: { id: "owner-b", type: "human" },
          });
          return {
            replacements: entries.map(({ entry, sessionKey }) => ({
              entry: { ...entry, model: "stale-owner-replacement" },
              sessionKey,
            })),
            result: undefined,
          };
        },
      }),
    ).rejects.toThrow("changed before replacement");

    expect(loadSessionEntry({ ...scope, readConsistency: "latest" })).toMatchObject({
      model: "base",
      owner: { actor: { id: "owner-b", type: "human" } },
      sessionId: "replacement-row",
    });
  });
});
