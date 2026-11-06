import { expect, it } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  loadExactSessionEntryCandidates,
  resolveSessionEntry,
} from "./session-accessor.sqlite-entry-admitted-read.js";
import {
  loadExactSessionEntryFromStoreReadOnly,
  loadSessionEntryByIdReadOnly,
  loadSessionEntryReadOnlyInScope,
  loadSessionEntryReadOnlyResultInScope,
} from "./session-accessor.sqlite-exact-read.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { runWithSessionActorStorage } from "./session-actor-storage-binding.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";

const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };

it("serves exact entry wrappers and projections from the selected memory owner after writes", async () => {
  const env = { OPENCLAW_STATE_DIR: "/synthetic/memory-exact-reader" };
  const options = {
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  };
  using _ = { [Symbol.dispose]: () => memorySessionActorOwners.closeDatabase(options) };
  const owner = memorySessionActorOwners.get(options);
  const sessionKey = "agent:main:dashboard:incognito-exact";
  const siblingKey = "agent:main:dashboard:incognito-sibling";
  const actor = await owner.acquire({ database: owner.identity, sessionKey }, lifetime);
  const sibling = await owner.acquire(
    { database: owner.identity, sessionKey: siblingKey },
    lifetime,
  );
  const storage = actor.storage!;
  const mutate = async <Kind extends "session.entry.create" | "session.entry.patch">(
    target: typeof storage,
    command: Parameters<typeof storage.mutate<Kind>>[0],
  ) => {
    expect(await target.mutate<Kind>(command, authority)).toMatchObject({ kind: "committed" });
  };
  await mutate(storage, {
    type: "session.entry.create",
    input: {
      entry: {
        sessionId: "exact-id",
        updatedAt: 1,
        label: "first",
        skillsSnapshot: { prompt: "large private snapshot", skills: [] },
      },
    },
  });
  await mutate(sibling.storage!, {
    type: "session.entry.create",
    input: { entry: { sessionId: "sibling-id", updatedAt: 2 } },
  });
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
    expect(source).toEqual({ ...options, databaseIdentity: owner.identity.incarnation });
    expect(
      loadSessionEntryReadOnlyInScope({ ...scope, databaseAgentId: "main", projection: "list" }),
    ).not.toHaveProperty("skillsSnapshot");
    const byId = { agentId: "main", storePath: options.path, sessionId: "sibling-id" };
    expect({
      result: loadSessionEntryReadOnlyResultInScope(scope),
      byId: loadSessionEntryByIdReadOnly(byId),
      exact: loadExactSessionEntryFromStoreReadOnly(scope),
    }).toMatchObject({
      result: { ok: true, value: { sessionId: "exact-id" } },
      byId: { sessionKey: siblingKey, entry: { sessionId: "sibling-id" } },
      exact: { sessionKey, entry: { label: "first" } },
    });
    const candidates = { readSource: source!, readOnly: true as const, expectedSource: source };
    expect(
      loadExactSessionEntryCandidates({ ...candidates, sessionKeys: [siblingKey, sessionKey] }),
    ).toMatchObject([{ sessionKey: siblingKey }, { sessionKey }]);
    expect(() =>
      loadExactSessionEntryCandidates({
        ...candidates,
        sessionKeys: [sessionKey],
        expectedSource: { ...source!, databaseIdentity: "replaced" },
      }),
    ).toThrow("changed before read");
    await mutate(storage, {
      type: "session.entry.patch",
      input: { operation: { kind: "fields", patch: { label: "updated" } } },
    });
    expect(loadSessionEntryReadOnlyInScope({ ...scope, databaseAgentId: "main" })).toMatchObject({
      label: "updated",
    });
  });
  await Promise.all([actor.release(), sibling.release()]);
});
