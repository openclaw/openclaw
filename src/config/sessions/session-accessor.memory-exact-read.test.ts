import { afterEach, expect, it } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  loadExactSessionEntryCandidates,
  loadExactSessionEntryCandidatesReadOnlyBatch,
  loadExactSessionEntryFromStoreReadOnly,
  loadSessionEntryByIdReadOnly,
  loadSessionEntryReadOnlyInScope,
  loadSessionEntryReadOnlyResultInScope,
  resolveSessionEntry,
} from "./session-accessor.sqlite-exact-read.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { runWithSessionActorStorage } from "./session-actor-storage-binding.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";

const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
const owners: Array<{ agentId: string; path: string }> = [];
afterEach(() => {
  for (const options of owners.splice(0)) memorySessionActorOwners.closeDatabase(options);
});

it("serves exact entry wrappers and projections from the selected memory owner after writes", async () => {
  const env = { OPENCLAW_STATE_DIR: "/synthetic/memory-exact-reader" };
  const options = {
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  };
  owners.push(options);
  const owner = memorySessionActorOwners.get(options);
  const sessionKey = "agent:main:dashboard:incognito-exact";
  const siblingKey = "agent:main:dashboard:incognito-sibling";
  const actor = await owner.acquire({ database: owner.identity, sessionKey }, lifetime);
  const sibling = await owner.acquire(
    { database: owner.identity, sessionKey: siblingKey },
    lifetime,
  );
  const storage = actor.storage!;
  expect(
    (
      await storage.mutate(
        {
          type: "session.entry.create",
          input: {
            entry: {
              sessionId: "exact-id",
              updatedAt: 1,
              label: "first",
              skillsSnapshot: { prompt: "large private snapshot", skills: [] },
            },
          },
        },
        authority,
      )
    ).kind,
  ).toBe("committed");
  expect(
    (
      await sibling.storage!.mutate(
        {
          type: "session.entry.create",
          input: { entry: { sessionId: "sibling-id", updatedAt: 2 } },
        },
        authority,
      )
    ).kind,
  ).toBe("committed");
  const scope = { agentId: "main", storePath: options.path, sessionKey, env };
  await runWithSessionActorStorage({ ...options, actor, authority }, async () => {
    let source: CapturedSessionEntryReadSource | undefined;
    expect(
      resolveSessionEntry(scope, {
        readOnly: true,
        onReadSource: (value) => {
          source = value;
        },
      }).existing,
    ).toMatchObject({ sessionId: "exact-id", label: "first" });
    expect(source).toEqual({
      agentId: "main",
      path: options.path,
      databaseIdentity: owner.identity.incarnation,
    });
    expect(
      loadSessionEntryReadOnlyInScope({ ...scope, databaseAgentId: "main", projection: "list" }),
    ).not.toHaveProperty("skillsSnapshot");
    expect(loadSessionEntryReadOnlyResultInScope(scope)).toMatchObject({
      ok: true,
      value: { sessionId: "exact-id" },
    });
    expect(
      loadSessionEntryByIdReadOnly({
        agentId: "main",
        storePath: options.path,
        sessionId: "sibling-id",
      }),
    ).toMatchObject({ sessionKey: siblingKey, entry: { sessionId: "sibling-id" } });
    expect(loadExactSessionEntryFromStoreReadOnly(scope)).toMatchObject({
      sessionKey,
      entry: { label: "first" },
    });
    expect(
      loadExactSessionEntryCandidates({
        readSource: source!,
        readOnly: true,
        sessionKeys: [siblingKey, sessionKey],
        expectedSource: source,
      }),
    ).toMatchObject([{ sessionKey: siblingKey }, { sessionKey }]);
    expect(() =>
      loadExactSessionEntryCandidates({
        readSource: source!,
        readOnly: true,
        sessionKeys: [sessionKey],
        expectedSource: { ...source!, databaseIdentity: "replaced" },
      }),
    ).toThrow("changed before read");
    expect(
      (
        await storage.mutate(
          {
            type: "session.entry.patch",
            input: { operation: { kind: "fields", patch: { label: "updated" } } },
          },
          authority,
        )
      ).kind,
    ).toBe("committed");
    expect(loadSessionEntryReadOnlyInScope({ ...scope, databaseAgentId: "main" })).toMatchObject({
      label: "updated",
    });
    const batches = loadExactSessionEntryCandidatesReadOnlyBatch([
      { ...scope, sessionKeys: [sessionKey], projection: "list" },
      { ...scope, sessionKeys: [siblingKey], projection: "delivery" },
    ]);
    expect(batches[0]).toMatchObject({ ok: true, value: [{ entry: { label: "updated" } }] });
    expect(batches[1]).toEqual({
      ok: true,
      value: [
        {
          sessionKey: siblingKey,
          entry: { sessionId: "sibling-id", updatedAt: 2, delivery: undefined, groupId: undefined },
        },
      ],
    });
  });
  await Promise.all([actor.release(), sibling.release()]);
});
